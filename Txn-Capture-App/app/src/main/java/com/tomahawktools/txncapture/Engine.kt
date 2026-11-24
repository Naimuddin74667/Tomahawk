package com.tomahawktools.txncapture

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Telephony
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.atomic.AtomicBoolean

/** Receives incoming SMS (multi-part messages are joined per sender). */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val msgs = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        val bySender = LinkedHashMap<String, StringBuilder>()
        var ts = System.currentTimeMillis()
        for (m in msgs) {
            val from = m.displayOriginatingAddress ?: m.originatingAddress ?: continue
            bySender.getOrPut(from) { StringBuilder() }.append(m.displayMessageBody ?: m.messageBody ?: "")
            if (m.timestampMillis > 0) ts = m.timestampMillis
        }
        for ((sender, body) in bySender) {
            try {
                Engine.handleSms(ctx, sender, body.toString(), ts)
            } catch (_: Exception) {
            }
        }
    }
}

/** Notification button actions: set category / mark salary. */
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val id = intent.getLongExtra("id", -1)
        if (id < 0) return
        when (intent.action) {
            ACTION_CAT -> intent.getStringExtra("cat")?.let { Engine.setCategory(ctx, id, it) }
            ACTION_SALARY -> Engine.setSalary(ctx, id, true)
        }
        Notifier.cancel(ctx, id)
    }

    companion object {
        const val ACTION_CAT = "com.tomahawktools.txncapture.CAT"
        const val ACTION_SALARY = "com.tomahawktools.txncapture.SALARY"
    }
}

object Engine {
    fun handleSms(ctx: Context, sender: String, body: String, ts: Long): Txn? {
        if (!SmsParser.isBankSender(sender)) return null
        val p = SmsParser.parse(body, sender) ?: return null
        return save(ctx, p, body, ts, Hash.sha1("$sender|${body.trim()}|${ts / 60000}"), "SMS")
    }

    /** Manually paste an old SMS from Settings. */
    fun importSms(ctx: Context, body: String): Txn? {
        val p = SmsParser.parse(body, "") ?: return null
        return save(ctx, p, body, System.currentTimeMillis(), Hash.sha1("IMPORT|${body.trim()}"), "IMPORT")
    }

    private fun save(ctx: Context, p: ParsedSms, body: String, ts: Long, hash: String, source: String): Txn? {
        val db = Db.get(ctx)
        val mkey = SmsParser.merchantKey(p.merchant)
        val isSalary = p.type == SmsParser.CREDIT && Prefs.looksLikeSalary(ctx, body, p.merchant, p.amount)
        val autoCat = if (p.type == SmsParser.DEBIT) db.merchantCat(mkey) else null
        val t = Txn(
            ts = ts, amount = p.amount, type = p.type, mode = p.mode, merchant = p.merchant, mkey = mkey,
            category = autoCat, account = p.account, bank = p.bank, isSalary = isSalary,
            source = source, raw = body, hash = hash
        )
        val id = db.insert(t)
        if (id < 0) return null
        val saved = t.copy(id = id)
        Notifier.onNewTxn(ctx, saved)
        if (autoCat != null) Budget.check(ctx, autoCat)
        FirebaseSync.syncAsync(ctx)
        return saved
    }

    fun setCategory(ctx: Context, id: Long, cat: String) {
        val db = Db.get(ctx)
        val t = db.get(id) ?: return
        db.setCategory(id, cat)
        if (t.isDebit && t.mkey.isNotBlank()) {
            db.setMerchantCat(t.mkey, cat)
            db.fillCategoryForMerchant(t.mkey, cat)
        }
        Budget.check(ctx, cat)
        FirebaseSync.syncAsync(ctx)
    }

    fun setSalary(ctx: Context, id: Long, flag: Boolean) {
        Db.get(ctx).setSalary(id, flag)
        FirebaseSync.syncAsync(ctx)
    }
}

object Budget {
    fun check(ctx: Context, cat: String) {
        val db = Db.get(ctx)
        val budget = db.budgets()[cat] ?: return
        val period = Periods.current(db)
        val spent = db.spentInCategory(cat, period.start, period.end)
        val level = when {
            spent >= budget -> 100
            spent >= budget * 0.8 -> 80
            else -> return
        }
        if (!Prefs.once(ctx, "alert_${cat}_${period.start}_$level")) return
        Notifier.budgetAlert(ctx, cat, spent, budget, level)
    }
}

object Notifier {
    private const val CH_TXN = "txn"
    private const val CH_INFO = "txn_info"
    private const val CH_BUDGET = "budget"

    fun createChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_TXN, "Navin kharcha (category vichara)", NotificationManager.IMPORTANCE_HIGH))
        nm.createNotificationChannel(NotificationChannel(CH_INFO, "Auto category / Jama", NotificationManager.IMPORTANCE_DEFAULT))
        nm.createNotificationChannel(NotificationChannel(CH_BUDGET, "Budget alerts", NotificationManager.IMPORTANCE_HIGH))
    }

    private const val FLAGS = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

    private fun pickerIntent(ctx: Context, id: Long): PendingIntent {
        val i = Intent(ctx, CategoryPickerActivity::class.java)
            .putExtra("id", id)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        return PendingIntent.getActivity(ctx, (id * 10).toInt(), i, FLAGS)
    }

    private fun mainIntent(ctx: Context, req: Int): PendingIntent {
        val i = Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(ctx, req, i, FLAGS)
    }

    private fun actionIntent(ctx: Context, id: Long, action: String, cat: String?, k: Int): PendingIntent {
        val i = Intent(ctx, ActionReceiver::class.java).setAction(action).putExtra("id", id)
        if (cat != null) i.putExtra("cat", cat)
        return PendingIntent.getBroadcast(ctx, (id * 10 + k).toInt(), i, FLAGS)
    }

    fun onNewTxn(ctx: Context, t: Txn) {
        val b: NotificationCompat.Builder
        if (t.isDebit) {
            if (t.category == null) {
                b = NotificationCompat.Builder(ctx, CH_TXN)
                    .setContentTitle("${Fmt.money(t.amount)} kharcha • ${t.merchant}")
                    .setContentText("Category nivada (${t.mode})")
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setContentIntent(pickerIntent(ctx, t.id))
                Db.get(ctx).topCategories(2).forEachIndexed { k, c ->
                    b.addAction(0, c, actionIntent(ctx, t.id, ActionReceiver.ACTION_CAT, c, k + 1))
                }
                b.addAction(0, "Itar…", pickerIntent(ctx, t.id))
            } else {
                b = NotificationCompat.Builder(ctx, CH_INFO)
                    .setContentTitle("${Fmt.money(t.amount)} → ${t.category}")
                    .setContentText("${t.merchant} • badlayla tap kara")
                    .setContentIntent(pickerIntent(ctx, t.id))
            }
        } else {
            if (t.isSalary) {
                b = NotificationCompat.Builder(ctx, CH_TXN)
                    .setContentTitle("💰 Salary ali: ${Fmt.money(t.amount)}")
                    .setContentText("Navin salary cycle suru jhala")
                    .setContentIntent(mainIntent(ctx, (t.id * 10).toInt()))
            } else {
                b = NotificationCompat.Builder(ctx, CH_INFO)
                    .setContentTitle("${Fmt.money(t.amount)} jama • ${t.merchant}")
                    .setContentText("Hi salary aahe ka? Tar button daba")
                    .setContentIntent(mainIntent(ctx, (t.id * 10).toInt()))
                    .addAction(0, "Salary aahe", actionIntent(ctx, t.id, ActionReceiver.ACTION_SALARY, null, 5))
            }
        }
        b.setSmallIcon(R.drawable.ic_notif).setAutoCancel(true)
        post(ctx, t.id.toInt(), b)
    }

    fun budgetAlert(ctx: Context, cat: String, spent: Double, budget: Double, level: Int) {
        val title = if (level >= 100) "⚠️ $cat budget sampla!" else "$cat budget 80% vaparla"
        val b = NotificationCompat.Builder(ctx, CH_BUDGET)
            .setSmallIcon(R.drawable.ic_notif)
            .setContentTitle(title)
            .setContentText("${Fmt.money(spent)} / ${Fmt.money(budget)} ya cycle madhe")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(mainIntent(ctx, 900000 + cat.hashCode() % 1000))
            .setAutoCancel(true)
        post(ctx, 1_000_000 + Math.abs(cat.hashCode() % 100000), b)
    }

    @SuppressLint("MissingPermission")
    private fun post(ctx: Context, id: Int, b: NotificationCompat.Builder) {
        val nm = NotificationManagerCompat.from(ctx)
        if (!nm.areNotificationsEnabled()) return
        try { nm.notify(id, b.build()) } catch (_: SecurityException) { }
    }

    fun cancel(ctx: Context, id: Long) = NotificationManagerCompat.from(ctx).cancel(id.toInt())
}

/** Optional backup to Firebase Realtime Database via REST (no SDK / google-services.json needed). */
object FirebaseSync {
    private val running = AtomicBoolean(false)
    private val main = Handler(Looper.getMainLooper())

    fun syncAsync(ctx: Context, onDone: ((String) -> Unit)? = null) {
        val app = ctx.applicationContext
        val base = Prefs.fbUrl(app).trimEnd('/')
        if (base.isBlank()) { onDone?.invoke("Firebase URL set nahi"); return }
        if (!running.compareAndSet(false, true)) { onDone?.invoke("Sync already chalu ahe"); return }
        Thread {
            val msg = try { syncNow(app, base) } catch (e: Exception) { "Sync error: ${e.message}" } finally { running.set(false) }
            onDone?.let { cb -> main.post { cb(msg) } }
        }.start()
    }

    private fun authQ(ctx: Context): String {
        val s = Prefs.fbSecret(ctx)
        return if (s.isBlank()) "" else "?auth=" + URLEncoder.encode(s, "UTF-8")
    }

    private fun syncNow(ctx: Context, base: String): String {
        val db = Db.get(ctx)
        val pending = db.unsynced()
        var ok = 0
        for (t in pending) {
            val json = JSONObject().apply {
                put("ts", t.ts); put("amount", t.amount); put("type", t.type); put("mode", t.mode)
                put("merchant", t.merchant); put("category", t.category ?: JSONObject.NULL)
                put("account", t.account ?: JSONObject.NULL); put("bank", t.bank ?: JSONObject.NULL)
                put("isSalary", t.isSalary); put("source", t.source); put("note", t.note ?: JSONObject.NULL)
                put("raw", t.raw ?: JSONObject.NULL)
            }
            if (http("PUT", "$base/txns/${t.hash}.json${authQ(ctx)}", json.toString())) {
                db.markSynced(t.id); ok++
            } else break
        }
        return "$ok / ${pending.size} sync jhale"
    }

    fun deleteAsync(ctx: Context, hash: String) {
        val app = ctx.applicationContext
        val base = Prefs.fbUrl(app).trimEnd('/')
        if (base.isBlank()) return
        Thread { try { http("DELETE", "$base/txns/$hash.json${authQ(app)}", null) } catch (_: Exception) { } }.start()
    }

    private fun http(method: String, url: String, body: String?): Boolean {
        val c = URL(url).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 10000; c.readTimeout = 10000
        if (body != null) {
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(body.toByteArray()) }
        }
        val code = c.responseCode
        c.disconnect()
        return code in 200..299
    }
}
