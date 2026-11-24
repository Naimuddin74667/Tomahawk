package com.tomahawktools.txncapture

import android.app.Application
import android.content.Context
import java.security.MessageDigest
import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.UUID

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifier.createChannels(this)
    }
}

object Fmt {
    private val inr: NumberFormat = NumberFormat.getNumberInstance(Locale("en", "IN"))
    fun money(v: Double): String {
        val whole = Math.abs(v % 1.0) < 0.005
        inr.minimumFractionDigits = if (whole) 0 else 2
        inr.maximumFractionDigits = if (whole) 0 else 2
        return (if (v < 0) "-₹" else "₹") + inr.format(Math.abs(v))
    }
    fun dateTime(ts: Long): String = SimpleDateFormat("dd MMM yy, hh:mm a", Locale.ENGLISH).format(Date(ts))
    fun date(ts: Long): String = SimpleDateFormat("dd MMM yyyy", Locale.ENGLISH).format(Date(ts))
    fun shortDate(ts: Long): String = SimpleDateFormat("dd MMM", Locale.ENGLISH).format(Date(ts))
    fun month(ts: Long): String = SimpleDateFormat("MMMM yyyy", Locale.ENGLISH).format(Date(ts))
}

object Hash {
    fun sha1(s: String): String =
        MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
    fun manual(): String = "m" + UUID.randomUUID().toString().replace("-", "")
}

object Prefs {
    private fun sp(ctx: Context) = ctx.getSharedPreferences("txncapture", Context.MODE_PRIVATE)

    fun employer(ctx: Context): String = sp(ctx).getString("employer", "") ?: ""
    fun minSalary(ctx: Context): Double = sp(ctx).getFloat("min_salary", 0f).toDouble()
    fun fbUrl(ctx: Context): String = sp(ctx).getString("fb_url", "") ?: ""
    fun fbSecret(ctx: Context): String = sp(ctx).getString("fb_secret", "") ?: ""

    fun saveSalary(ctx: Context, employer: String, min: Double) =
        sp(ctx).edit().putString("employer", employer.trim()).putFloat("min_salary", min.toFloat()).apply()

    fun saveFirebase(ctx: Context, url: String, secret: String) =
        sp(ctx).edit().putString("fb_url", url.trim()).putString("fb_secret", secret.trim()).apply()

    /** returns true the first time a key is seen */
    fun once(ctx: Context, key: String): Boolean {
        val p = sp(ctx)
        if (p.getBoolean(key, false)) return false
        p.edit().putBoolean(key, true).apply()
        return true
    }

    fun looksLikeSalary(ctx: Context, body: String, merchant: String, amount: Double): Boolean {
        val t = (body + " " + merchant).lowercase()
        if (Regex("""\bsalary\b|\bsal\b|\bsal[-/ ]|\bpayroll\b""").containsMatchIn(t)) return true
        val emp = employer(ctx).lowercase()
        if (emp.isNotBlank() && emp.split(",").map { it.trim() }.any { it.isNotEmpty() && t.contains(it) }) return true
        val min = minSalary(ctx)
        return min > 0 && amount >= min
    }
}

data class Period(val start: Long, val end: Long, val label: String, val salaryBased: Boolean)

object Periods {
    private const val MERGE_GAP = 5L * 24 * 60 * 60 * 1000 // salary credits within 5 days = same cycle

    /** Newest first. Salary cycles if any salary is known, else calendar months. */
    fun list(db: Db): List<Period> {
        val sal = db.salaryTimes() // desc
        val starts = ArrayList<Long>()
        for (t in sal.reversed()) { // asc
            if (starts.isEmpty() || t - starts.last() > MERGE_GAP) starts.add(t)
        }
        val out = ArrayList<Period>()
        if (starts.isNotEmpty()) {
            val desc = starts.reversed()
            for (i in desc.indices) {
                val s = desc[i]
                val e = if (i == 0) Long.MAX_VALUE else desc[i - 1]
                val label = if (i == 0) "Salary cycle: ${Fmt.shortDate(s)} → aaj"
                else "Salary cycle: ${Fmt.shortDate(s)} → ${Fmt.shortDate(e)}"
                out.add(Period(s, e, label, true))
            }
            out.add(Period(0, desc.last(), "Pahili salary aadhi", false))
        } else {
            val cal = Calendar.getInstance()
            cal.set(Calendar.DAY_OF_MONTH, 1)
            cal.set(Calendar.HOUR_OF_DAY, 0); cal.set(Calendar.MINUTE, 0)
            cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0)
            var end = Long.MAX_VALUE
            repeat(12) {
                val s = cal.timeInMillis
                out.add(Period(s, end, Fmt.month(s), false))
                end = s
                cal.add(Calendar.MONTH, -1)
            }
        }
        return out
    }

    fun current(db: Db): Period = list(db).first()
}
