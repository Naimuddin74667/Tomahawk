package com.tomahawktools.txncapture

import android.Manifest
import android.app.AlertDialog
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.CheckBox
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.bottomnavigation.BottomNavigationView
import java.util.Calendar

interface Screen {
    val view: View
    fun refresh()
}

class MainActivity : AppCompatActivity() {
    private lateinit var content: FrameLayout
    private lateinit var nav: BottomNavigationView
    private val screens = HashMap<Int, Screen>()
    private var currentTab = TAB_DASH
    val db by lazy { Db.get(this) }

    private val permLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { refresh() }

    private val exportLauncher =
        registerForActivityResult(ActivityResultContracts.CreateDocument("text/csv")) { uri -> uri?.let { writeCsv(it) } }

    companion object {
        const val TAB_DASH = 1
        const val TAB_LIST = 2
        const val TAB_SETTINGS = 3
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = vbox()
        content = FrameLayout(this).apply { setBackgroundColor(C.BG) }
        root.addView(content, LinearLayout.LayoutParams(MATCH, 0, 1f))
        nav = BottomNavigationView(this)
        nav.menu.add(0, TAB_DASH, 0, "Dashboard").setIcon(android.R.drawable.ic_menu_view)
        nav.menu.add(0, TAB_LIST, 1, "Transactions").setIcon(android.R.drawable.ic_menu_agenda)
        nav.menu.add(0, TAB_SETTINGS, 2, "Settings").setIcon(android.R.drawable.ic_menu_preferences)
        nav.setOnItemSelectedListener { showInternal(it.itemId); true }
        root.addView(nav, LinearLayout.LayoutParams(MATCH, WRAP))
        setContentView(root)
        supportActionBar?.title = "Txn Capture • Salary Tracker"
        show(TAB_DASH)
        if (!hasSmsPerm()) askPermissions()
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    fun refresh() = screens[currentTab]?.refresh()

    fun show(tab: Int) {
        if (nav.selectedItemId != tab) nav.selectedItemId = tab // triggers listener -> showInternal
        else showInternal(tab)
    }

    private fun showInternal(tab: Int) {
        currentTab = tab
        val s = screens.getOrPut(tab) {
            when (tab) {
                TAB_LIST -> ListScreen(this)
                TAB_SETTINGS -> SettingsScreen(this)
                else -> DashboardScreen(this)
            }
        }
        content.removeAllViews()
        content.addView(s.view, FrameLayout.LayoutParams(MATCH, MATCH))
        s.refresh()
    }

    fun openUncategorized() {
        (screens.getOrPut(TAB_LIST) { ListScreen(this) } as ListScreen).onlyUncat = true
        show(TAB_LIST)
    }

    fun hasSmsPerm() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED

    fun hasNotifPerm() = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun askPermissions() {
        val list = mutableListOf(Manifest.permission.RECEIVE_SMS)
        if (Build.VERSION.SDK_INT >= 33) list.add(Manifest.permission.POST_NOTIFICATIONS)
        permLauncher.launch(list.toTypedArray())
    }

    fun openAppSettings() {
        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
    }

    fun exportCsv() = exportLauncher.launch("txn-capture-${System.currentTimeMillis() / 1000}.csv")

    private fun writeCsv(uri: Uri) {
        fun q(s: String?) = "\"" + (s ?: "").replace("\"", "\"\"").replace("\n", " ") + "\""
        val sb = StringBuilder("Date,Type,Amount,Category,Merchant,Mode,Bank,Account,Salary,Source,Note,SMS\n")
        for (t in db.all().reversed()) {
            sb.append(listOf(
                q(Fmt.dateTime(t.ts)), if (t.isDebit) "Kharcha" else "Jama", "%.2f".format(t.amount),
                q(t.category), q(t.merchant), t.mode, q(t.bank), q(t.account), if (t.isSalary) "Yes" else "",
                t.source, q(t.note), q(t.raw)
            ).joinToString(",")).append('\n')
        }
        try {
            contentResolver.openOutputStream(uri)?.use { it.write(("﻿" + sb).toByteArray()) }
            toast("Export jhala ✔")
        } catch (e: Exception) {
            toast("Export error: ${e.message}")
        }
    }
}

// ======================= Dashboard =======================
class DashboardScreen(private val a: MainActivity) : Screen {
    private var idx = 0
    private val body = a.vbox(12)
    override val view: View = ScrollView(a).apply { addView(body) }

    override fun refresh() {
        body.removeAllViews()
        val periods = Periods.list(a.db)
        if (idx >= periods.size) idx = 0
        val p = periods[idx]

        if (!a.hasSmsPerm()) {
            body.add(a.card().apply {
                setBackgroundColor(Color.parseColor("#FEF3C7"))
                add(a.label("SMS permission nahi. Tyashivay auto-tracking honar nahi.", 14f, C.TEXT, true), 0)
                add(a.button("Permission dya") { a.askPermissions() })
            }, 0)
        }

        // period switcher
        val sw = a.hbox()
        sw.addView(a.button("◀", false) { if (idx < periods.size - 1) { idx++; refresh() } }, LinearLayout.LayoutParams(a.dp(52), WRAP))
        sw.addView(a.label(p.label, 15f, C.TEXT, true).apply { gravity = Gravity.CENTER }, LinearLayout.LayoutParams(0, WRAP, 1f))
        sw.addView(a.button("▶", false) { if (idx > 0) { idx--; refresh() } }, LinearLayout.LayoutParams(a.dp(52), WRAP))
        body.add(sw, 4)

        val txns = a.db.between(p.start, p.end)
        val salary = txns.filter { !it.isDebit && it.isSalary }.sumOf { it.amount }
        val otherIn = txns.filter { !it.isDebit && !it.isSalary }.sumOf { it.amount }
        val debits = txns.filter { it.isDebit }
        val selfT = debits.filter { it.category == Db.SELF }.sumOf { it.amount }
        val spent = debits.filter { it.category != Db.SELF }.sumOf { it.amount }
        val left = salary + otherIn - spent - selfT

        // Big "baki" card
        body.add(a.card().apply {
            setBackgroundColor(C.PRIMARY)
            add(a.label("Baki (salary + jama − kharcha)", 13f, Color.parseColor("#C7D2FE")), 0)
            add(a.label(Fmt.money(left), 32f, if (left >= 0) Color.WHITE else Color.parseColor("#FCA5A5"), true), 2)
            if (salary > 0) {
                val pct = (spent / salary * 100).toInt().coerceIn(0, 100)
                add(ProgressBar(a, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100; progress = pct }, 8)
                add(a.label("Salary cha $pct% kharch jhala", 12f, Color.parseColor("#C7D2FE")), 2)
            }
        }, 10)

        // stat row
        val row = a.hbox()
        fun stat(title: String, v: Double, col: Int) = a.card().apply {
            add(a.label(title, 12f, C.MUTED), 0); add(a.label(Fmt.money(v), 16f, col, true), 2)
        }
        val m = a.dp(4)
        row.addView(stat("Salary", salary, C.GREEN), LinearLayout.LayoutParams(0, WRAP, 1f).apply { rightMargin = m })
        row.addView(stat("Itar jama", otherIn, C.GREEN), LinearLayout.LayoutParams(0, WRAP, 1f).apply { leftMargin = m; rightMargin = m })
        row.addView(stat("Kharcha", spent, C.RED), LinearLayout.LayoutParams(0, WRAP, 1f).apply { leftMargin = m })
        body.add(row, 10)

        val uncat = debits.count { it.category == null }
        if (uncat > 0) {
            body.add(a.button("⚠ $uncat kharchyanna category nahi. Ata nivada") { a.openUncategorized() }, 10)
        }
        if (salary == 0.0 && p.salaryBased.not() && idx == 0) {
            body.add(a.label("Tip: Salary SMS ala ki auto olakhel. Na olakhlyas Transactions madhe ti entry ughada ani 'Salary' tick kara, kiwa Settings madhe company naav taka.", 12f, C.MUTED), 8)
        }

        // category breakdown
        val byCat = LinkedHashMap<String, Double>()
        for (t in debits) {
            val k = t.category ?: "Category nahi"
            byCat[k] = (byCat[k] ?: 0.0) + t.amount
        }
        val budgets = a.db.budgets()
        for (b in budgets.keys) if (b !in byCat) byCat[b] = 0.0
        val sorted = byCat.entries.sortedByDescending { it.value }
        val cats = a.db.categories()
        fun colorOf(k: String): Int = if (k == "Category nahi") Color.parseColor("#9CA3AF")
        else C.PALETTE[(cats.indexOf(k).takeIf { it >= 0 } ?: Math.abs(k.hashCode())) % C.PALETTE.size]

        val chartCard = a.card()
        chartCard.add(a.label("Kuthe kiti kharch", 16f, C.TEXT, true), 0)
        val pie = PieChartView(a)
        pie.setData(sorted.filter { it.key != Db.SELF }.map { it.value to colorOf(it.key) }, Fmt.money(spent))
        chartCard.add(pie, 8)
        for ((k, v) in sorted) {
            val r = a.vbox()
            val line = a.hbox()
            line.addView(View(a).apply { setBackgroundColor(colorOf(k)) }, LinearLayout.LayoutParams(a.dp(12), a.dp(12)).apply { rightMargin = a.dp(8) })
            val pct = if (spent > 0 && k != Db.SELF) " (${(v / spent * 100).toInt()}%)" else ""
            line.addView(a.label(k + pct, 14f), LinearLayout.LayoutParams(0, WRAP, 1f))
            line.addView(a.label(Fmt.money(v), 14f, C.TEXT, true))
            r.addView(line)
            val bud = budgets[k]
            if (bud != null && bud > 0) {
                val pp = (v / bud * 100).toInt()
                r.add(ProgressBar(a, null, android.R.attr.progressBarStyleHorizontal).apply {
                    max = 100; progress = pp.coerceAtMost(100)
                    if (pp >= 100) progressTintList = android.content.res.ColorStateList.valueOf(C.RED)
                    else if (pp >= 80) progressTintList = android.content.res.ColorStateList.valueOf(C.ACCENT)
                }, 2)
                r.add(a.label("Budget ${Fmt.money(bud)} • baki ${Fmt.money(bud - v)}", 11f, if (pp >= 100) C.RED else C.MUTED), 0)
            }
            if (k == Db.SELF) r.add(a.label("(Swatahchya account madhe transfer — kharchat dharla nahi)", 11f, C.MUTED), 0)
            chartCard.add(r, 10)
        }
        if (sorted.isEmpty()) chartCard.add(a.label("Ya period madhe ajun kharcha nahi.", 13f, C.MUTED))
        body.add(chartCard, 10)

        // mode breakdown
        if (debits.isNotEmpty()) {
            val modeCard = a.card()
            modeCard.add(a.label("Payment mode", 16f, C.TEXT, true), 0)
            debits.groupBy { it.mode }.mapValues { e -> e.value.sumOf { it.amount } }
                .entries.sortedByDescending { it.value }.forEach { (mo, v) ->
                    val line = a.hbox()
                    line.addView(a.label(mo, 14f), LinearLayout.LayoutParams(0, WRAP, 1f))
                    line.addView(a.label(Fmt.money(v), 14f, C.TEXT, true))
                    modeCard.add(line, 6)
                }
            body.add(modeCard, 10)
        }
        body.add(View(a), 40)
    }
}

// ======================= Transactions =======================
class ListScreen(private val a: MainActivity) : Screen {
    var onlyUncat = false
    private var query = ""
    private val items = ArrayList<Txn>()
    private val count = a.label("", 12f, C.MUTED)
    private val uncatBox = CheckBox(a).apply { text = "Fakt category nasleli" }
    private val adapter = TxnAdapter()
    override val view: View

    init {
        val root = a.vbox(10)
        val top = a.hbox()
        val search = a.input("Shodha (merchant / category / amount)")
        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, st: Int, c: Int, af: Int) {}
            override fun onTextChanged(s: CharSequence?, st: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: Editable?) { query = s?.toString()?.trim()?.lowercase() ?: ""; refresh() }
        })
        top.addView(search, LinearLayout.LayoutParams(0, WRAP, 1f))
        top.addView(a.button("+ Navin") { TxnEditor.show(a, null) { refresh() } })
        root.addView(top)
        uncatBox.setOnCheckedChangeListener { _, c -> onlyUncat = c; refresh() }
        val r2 = a.hbox(); r2.addView(uncatBox, LinearLayout.LayoutParams(0, WRAP, 1f)); r2.addView(count)
        root.addView(r2)
        val rv = RecyclerView(a).apply { layoutManager = LinearLayoutManager(a); adapter = this@ListScreen.adapter }
        root.addView(rv, LinearLayout.LayoutParams(MATCH, 0, 1f))
        view = root
    }

    override fun refresh() {
        if (uncatBox.isChecked != onlyUncat) uncatBox.isChecked = onlyUncat
        items.clear()
        for (t in a.db.all()) {
            if (onlyUncat && !(t.isDebit && t.category == null)) continue
            if (query.isNotEmpty()) {
                val hay = "${t.merchant} ${t.category ?: ""} ${t.amount} ${t.note ?: ""} ${t.bank ?: ""}".lowercase()
                if (!hay.contains(query)) continue
            }
            items.add(t)
        }
        count.text = "${items.size} entries"
        adapter.notifyDataSetChanged()
    }

    inner class Holder(val box: LinearLayout, val title: TextView, val sub: TextView, val amt: TextView, val cat: TextView) :
        RecyclerView.ViewHolder(box)

    inner class TxnAdapter : RecyclerView.Adapter<Holder>() {
        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
            val box = a.card()
            box.layoutParams = RecyclerView.LayoutParams(MATCH, WRAP).apply { topMargin = a.dp(6); leftMargin = a.dp(2); rightMargin = a.dp(2) }
            val line = a.hbox()
            val title = a.label("", 15f, C.TEXT, true)
            val amt = a.label("", 15f, C.TEXT, true)
            line.addView(title, LinearLayout.LayoutParams(0, WRAP, 1f)); line.addView(amt)
            val line2 = a.hbox()
            val sub = a.label("", 12f, C.MUTED)
            val cat = a.label("", 12f, C.PRIMARY, true)
            line2.addView(sub, LinearLayout.LayoutParams(0, WRAP, 1f)); line2.addView(cat)
            box.addView(line); box.addView(line2)
            return Holder(box, title, sub, amt, cat)
        }

        override fun getItemCount() = items.size

        override fun onBindViewHolder(h: Holder, pos: Int) {
            val t = items[pos]
            h.title.text = t.merchant
            h.amt.text = (if (t.isDebit) "− " else "+ ") + Fmt.money(t.amount)
            h.amt.setTextColor(if (t.isDebit) C.RED else C.GREEN)
            h.sub.text = "${Fmt.dateTime(t.ts)} • ${t.mode}" + (t.bank?.let { " • $it" } ?: "")
            h.cat.text = when {
                t.isSalary -> "💰 Salary"
                !t.isDebit -> "Jama"
                t.category == null -> "⚠ Category nivada"
                else -> t.category
            }
            h.cat.setTextColor(if (t.isDebit && t.category == null) C.ACCENT else C.PRIMARY)
            h.box.setOnClickListener { TxnEditor.show(a, t) { refresh() } }
        }
    }
}

// ======================= Add / Edit dialog =======================
object TxnEditor {
    fun show(a: MainActivity, existing: Txn?, onDone: () -> Unit) {
        val db = a.db
        val cal = Calendar.getInstance().apply { timeInMillis = existing?.ts ?: System.currentTimeMillis() }
        val box = a.vbox(16)
        val rg = RadioGroup(a).apply { orientation = RadioGroup.HORIZONTAL }
        val rDebit = RadioButton(a).apply { text = "Kharcha"; id = View.generateViewId() }
        val rCredit = RadioButton(a).apply { text = "Jama"; id = View.generateViewId() }
        rg.addView(rDebit); rg.addView(rCredit)
        if (existing == null || existing.isDebit) rDebit.isChecked = true else rCredit.isChecked = true
        box.add(rg, 0)
        val amount = a.input("Amount ₹", existing?.amount?.let { if (it % 1.0 == 0.0) it.toLong().toString() else it.toString() } ?: "", number = true)
        box.add(amount)
        val merchant = a.input("Kuthe / kunala (merchant)", existing?.merchant?.takeIf { it != "Unknown" } ?: if (existing == null) "Cash" else "")
        box.add(merchant)
        val cats = listOf("(category nahi)") + db.categories()
        val spinner = Spinner(a).apply {
            adapter = ArrayAdapter(a, android.R.layout.simple_spinner_dropdown_item, cats)
            val i = cats.indexOf(existing?.category ?: "")
            setSelection(if (i >= 0) i else 0)
        }
        box.add(a.label("Category", 12f, C.MUTED)); box.add(spinner, 0)
        val salary = CheckBox(a).apply { text = "Hi Salary aahe"; isChecked = existing?.isSalary == true }
        box.add(salary)
        fun sync() {
            spinner.visibility = if (rDebit.isChecked) View.VISIBLE else View.GONE
            salary.visibility = if (rDebit.isChecked) View.GONE else View.VISIBLE
        }
        rg.setOnCheckedChangeListener { _, _ -> sync() }; sync()
        val note = a.input("Note (optional)", existing?.note ?: "")
        box.add(note)
        val dateBtn = a.button(Fmt.dateTime(cal.timeInMillis), false) {}
        dateBtn.setOnClickListener {
            DatePickerDialog(a, { _, y, mo, d ->
                cal.set(y, mo, d)
                TimePickerDialog(a, { _, hh, mm ->
                    cal.set(Calendar.HOUR_OF_DAY, hh); cal.set(Calendar.MINUTE, mm)
                    dateBtn.text = Fmt.dateTime(cal.timeInMillis)
                }, cal.get(Calendar.HOUR_OF_DAY), cal.get(Calendar.MINUTE), false).show()
            }, cal.get(Calendar.YEAR), cal.get(Calendar.MONTH), cal.get(Calendar.DAY_OF_MONTH)).show()
        }
        box.add(dateBtn)
        if (existing?.raw != null) box.add(a.label("SMS: " + existing.raw, 11f, C.MUTED), 12)

        val dlg = AlertDialog.Builder(a)
            .setTitle(if (existing == null) "Navin entry (cash / manual)" else "Entry badla")
            .setView(ScrollView(a).apply { addView(box) })
            .setPositiveButton("Save", null)
            .setNegativeButton("Cancel", null)
        if (existing != null) dlg.setNeutralButton("Delete") { _, _ ->
            AlertDialog.Builder(a).setMessage("Hi entry delete karaychi?")
                .setPositiveButton("Ho") { _, _ ->
                    db.delete(existing.id); FirebaseSync.deleteAsync(a, existing.hash); onDone()
                }.setNegativeButton("Nako", null).show()
        }
        val d = dlg.create()
        d.setOnShowListener {
            d.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val amt = amount.text.toString().replace(",", "").toDoubleOrNull()
                if (amt == null || amt <= 0) { amount.error = "Amount taka"; return@setOnClickListener }
                val isDebit = rDebit.isChecked
                val cat = if (isDebit && spinner.selectedItemPosition > 0) cats[spinner.selectedItemPosition] else null
                val mer = merchant.text.toString().trim().ifEmpty { "Unknown" }
                val mkey = SmsParser.merchantKey(mer)
                val base = existing ?: Txn(
                    ts = cal.timeInMillis, amount = amt, type = SmsParser.DEBIT, mode = "CASH", merchant = mer,
                    mkey = mkey, category = null, account = null, bank = null, isSalary = false,
                    source = "MANUAL", raw = null, hash = Hash.manual()
                )
                val t = base.copy(
                    ts = cal.timeInMillis, amount = amt,
                    type = if (isDebit) SmsParser.DEBIT else SmsParser.CREDIT,
                    merchant = mer, mkey = mkey, category = cat,
                    isSalary = !isDebit && salary.isChecked,
                    note = note.text.toString().trim().ifEmpty { null }
                )
                if (existing == null) db.insert(t) else db.update(t)
                if (cat != null && existing != null && existing.category != cat) {
                    Engine.setCategory(a, existing.id, cat)
                } else {
                    if (cat != null) Budget.check(a, cat)
                    FirebaseSync.syncAsync(a)
                }
                if (existing != null) Notifier.cancel(a, existing.id)
                d.dismiss(); onDone()
            }
        }
        d.show()
    }
}

// ======================= Settings =======================
class SettingsScreen(private val a: MainActivity) : Screen {
    private val body = a.vbox(12)
    override val view: View = ScrollView(a).apply { addView(body) }

    override fun refresh() {
        body.removeAllViews()

        // permissions
        body.add(a.card().apply {
            add(a.label("Permissions", 16f, C.TEXT, true), 0)
            add(a.label((if (a.hasSmsPerm()) "✔" else "✖") + " SMS vachne", 14f, if (a.hasSmsPerm()) C.GREEN else C.RED))
            add(a.label((if (a.hasNotifPerm()) "✔" else "✖") + " Notifications", 14f, if (a.hasNotifPerm()) C.GREEN else C.RED), 2)
            if (!a.hasSmsPerm() || !a.hasNotifPerm()) add(a.button("Permission dya") { a.askPermissions() })
            add(a.button("App settings ughda", false) { a.openAppSettings() })
            add(a.label("Xiaomi/Redmi/Vivo/Oppo: App settings madhe Autostart ON kara ani Battery 'No restrictions' theva, nahitar SMS miss hotil.", 12f, C.MUTED))
        }, 0)

        // salary
        val emp = a.input("Company / employer naav (comma ne anek)", Prefs.employer(a))
        val min = a.input("Ya peksha motha credit = salary (₹, optional)", Prefs.minSalary(a).let { if (it > 0) it.toLong().toString() else "" }, number = true)
        body.add(a.card().apply {
            add(a.label("Salary olakh", 16f, C.TEXT, true), 0)
            add(a.label("SMS madhe 'salary/sal' asel tar auto olakhte. Shivay khalil mahiti dili tar jasta accurate.", 12f, C.MUTED))
            add(emp); add(min)
            add(a.button("Save") {
                Prefs.saveSalary(a, emp.text.toString(), min.text.toString().toDoubleOrNull() ?: 0.0); a.toast("Saved ✔")
            })
        }, 10)

        // budgets
        val budgets = a.db.budgets()
        val cats = a.db.categories()
        val inputs = LinkedHashMap<String, android.widget.EditText>()
        val bCard = a.card()
        bCard.add(a.label("Monthly budget (per salary cycle)", 16f, C.TEXT, true), 0)
        bCard.add(a.label("80% ani 100% jhala ki alert yeil. Rikama = budget nahi.", 12f, C.MUTED))
        for (c in cats) {
            if (c == Db.SELF) continue
            val row = a.hbox()
            row.addView(a.label(c, 14f), LinearLayout.LayoutParams(0, WRAP, 1f))
            val e = a.input("₹", budgets[c]?.toLong()?.toString() ?: "", number = true)
            row.addView(e, LinearLayout.LayoutParams(a.dp(120), WRAP))
            inputs[c] = e
            bCard.add(row, 0)
        }
        bCard.add(a.button("Budget save kara") {
            for ((c, e) in inputs) a.db.setBudget(c, e.text.toString().toDoubleOrNull() ?: 0.0)
            a.toast("Budget saved ✔")
        })
        body.add(bCard, 10)

        // categories
        val newCat = a.input("Navin category naav")
        body.add(a.card().apply {
            add(a.label("Categories", 16f, C.TEXT, true), 0)
            add(a.label(cats.joinToString(" • "), 12f, C.MUTED))
            val row = a.hbox()
            row.addView(newCat, LinearLayout.LayoutParams(0, WRAP, 1f))
            row.addView(a.button("Add") {
                val n = newCat.text.toString().trim()
                if (n.isNotEmpty()) { a.db.addCategory(n); refresh() }
            })
            add(row)
            add(a.button("Category kadha", false) {
                val list = cats.filter { it != Db.SELF }.toTypedArray()
                AlertDialog.Builder(a).setTitle("Konti category kadhaychi?")
                    .setItems(list) { _, i -> a.db.deleteCategory(list[i]); refresh() }.show()
            })
        }, 10)

        // test / import SMS
        val sms = a.input("Bank cha SMS ithe paste kara", multi = true)
        val result = a.label("", 13f)
        body.add(a.card().apply {
            add(a.label("SMS test / juna SMS add kara", 16f, C.TEXT, true), 0)
            add(a.label("App tumcha bank SMS barobar vachto ka te check kara. Juna SMS add karaycha asel tar 'Add' daba (nantar date badla).", 12f, C.MUTED))
            add(sms)
            val row = a.hbox()
            row.addView(a.button("Check", false) {
                val p = SmsParser.parse(sms.text.toString())
                result.text = if (p == null) "✖ Ha transaction SMS mhanun olakhla nahi."
                else "✔ ${if (p.type == SmsParser.DEBIT) "Kharcha" else "Jama"} ${Fmt.money(p.amount)}\nMerchant: ${p.merchant}\nMode: ${p.mode}  A/c: ${p.account ?: "-"}"
                result.setTextColor(if (p == null) C.RED else C.GREEN)
            }, LinearLayout.LayoutParams(0, WRAP, 1f))
            row.addView(a.button("Add") {
                val t = Engine.importSms(a, sms.text.toString())
                if (t == null) a.toast("Olakhla nahi / aadhich add ahe")
                else { a.toast("Add jhala ✔"); sms.setText(""); TxnEditor.show(a, t) {} }
            }, LinearLayout.LayoutParams(0, WRAP, 1f))
            add(row)
            add(result)
        }, 10)

        // firebase
        val url = a.input("https://xxxx-default-rtdb.asia-southeast1.firebasedatabase.app", Prefs.fbUrl(a))
        val secret = a.input("Database secret / auth token (optional)", Prefs.fbSecret(a))
        val status = a.label("", 12f, C.MUTED)
        body.add(a.card().apply {
            add(a.label("Firebase backup (optional)", 16f, C.TEXT, true), 0)
            add(a.label("Realtime Database URL dila tar sagle transactions /txns madhe backup hotil.", 12f, C.MUTED))
            add(url); add(secret)
            add(a.button("Save + Sync now") {
                Prefs.saveFirebase(a, url.text.toString(), secret.text.toString())
                status.text = "Sync chalu…"
                FirebaseSync.syncAsync(a) { status.text = it }
            })
            add(status)
        }, 10)

        // export
        body.add(a.card().apply {
            add(a.label("Export", 16f, C.TEXT, true), 0)
            add(a.label("Sagle transactions CSV madhe (Excel madhe ughadta yeil).", 12f, C.MUTED))
            add(a.button("Excel / CSV export") { a.exportCsv() })
        }, 10)
        body.add(View(a), 40)
    }
}

// ======================= Notification category picker =======================
class CategoryPickerActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val id = intent.getLongExtra("id", -1)
        val db = Db.get(this)
        val t = db.get(id)
        if (t == null) { finish(); return }
        val box = vbox(18)
        box.add(label("${Fmt.money(t.amount)} kharcha", 22f, C.RED, true), 0)
        box.add(label("${t.merchant} • ${t.mode} • ${Fmt.dateTime(t.ts)}", 13f, C.MUTED), 2)
        if (t.category != null) box.add(label("Atta: ${t.category}", 13f, C.PRIMARY, true), 4)
        box.add(label("Category nivada:", 14f, C.TEXT, true), 12)
        val grid = GridLayout(this).apply { columnCount = 3 }
        for (c in db.categories()) {
            val b = button(c, c == t.category) {
                Engine.setCategory(this, id, c)
                Notifier.cancel(this, id)
                toast("$c ✔" + if (t.mkey.isNotBlank()) " (pudhchya veli auto)" else "")
                finish()
            }
            b.textSize = 13f
            grid.addView(b, GridLayout.LayoutParams().apply {
                width = 0; columnSpec = GridLayout.spec(GridLayout.UNDEFINED, 1f)
                setMargins(dp(3), dp(3), dp(3), dp(3))
            })
        }
        box.add(grid, 6)
        box.add(button("Nantar", false) { finish() }, 10)
        setContentView(ScrollView(this).apply { addView(box) })
        window.setLayout(MATCH, WRAP)
    }
}
