package com.tomahawktools.txncapture

/**
 * Generic Indian bank SMS parser. Pure Kotlin (no Android deps) so it is unit-tested in CI.
 */
data class ParsedSms(
    val amount: Double,
    val type: String,      // DEBIT / CREDIT
    val mode: String,      // UPI / CARD / ATM / NEFT / IMPS / RTGS / NETBANKING / OTHER
    val merchant: String,
    val account: String?,
    val bank: String?
)

object SmsParser {
    const val DEBIT = "DEBIT"
    const val CREDIT = "CREDIT"

    private val amountRx =
        Regex("""(?i)(?:rs\.?|inr|₹)\s*:?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)""")

    private val ignoreRx = Regex(
        """(?i)\b(otp|one[\s-]time[\s-]password|verification code|will be debited|to be debited|""" +
            """will be credited|is due|due on|due date|due by|min(?:imum)?\.? (?:amt|amount)|""" +
            """total (?:amt|amount) due|statement (?:for|of|is|generated)|collect request|has requested|""" +
            """is requesting|requested (?:money|rs|inr)|declined|failed|unsuccessful|could not be|""" +
            """pre-?approved|loan offer|reminder|autopay (?:is )?scheduled|mandate (?:is )?(?:created|registered|set up))\b"""
    )

    private val bankCtxRx =
        Regex("""(?i)(a/?c\b|acct|account|\bcard\b|upi|vpa|neft|imps|rtgs|\batm\b|bank|wallet|\bac\b|xx\d|\*\d)""")

    private val debitRx = Regex(
        """(?i)\b(debited|debit|spent|paid|sent|withdrawn|withdrawal|purchased?|transferred to|""" +
            """txn of|transaction of|for using|used at|dr)\b"""
    )
    private val creditRx =
        Regex("""(?i)\b(credited|credit|received|deposited|refund(?:ed)?|reversed|cr)\b""")

    private val stopWords = """on|ref|refno|ref no|upi|via|avl|avbl|txn|from|not you|bal|date|dt|info|imps|neft|for|using|with|is|has|-"""

    private val accountRx = Regex(
        """(?i)(?:a/?c|acct|account|card|\bac)\s*(?:no\.?|number)?\s*(?:ending\s*(?:with|in)?)?\s*[:\-]?\s*[x*#.]*\s*(\d{3,6})\b"""
    )

    private fun stopAhead() = """(?=\s+(?:$stopWords)\b|\s*[;,(]|\.\s|\.$|\s*$)"""

    private val vpaRx = Regex("""(?i)\b(?:vpa|upi id)\s*:?\s*([a-z0-9.\-_]+@[a-z0-9.]+)""")
    private val anyVpaRx = Regex("""(?i)\b([a-z0-9.\-_]{2,}@[a-z]{2,}[a-z0-9]*)\b""")
    private val upiPathRx = Regex("""(?i)UPI/(?:P2[AMP]|CR|DR)/\d+/([^/]+?)(?=\.\s|\s*/|\s*$)""")
    private val iciciRx = Regex("""(?i);\s*([^;\n]+?)\s+credited\b""")
    private val trfToRx = Regex("""(?i)\b(?:trf|transfer(?:red)?|sent|paid)\s+to\s+([^\n]+?)""" + stopAhead())
    private val toRx = Regex(
        """(?i)\bto\s+(?!(?:a/?c|ac|acct|account|your|you|beneficiary|bank)\b)([^\n]+?)""" + stopAhead()
    )
    private val atRx = Regex("""(?i)\bat\s+([^\n]+?)""" + stopAhead())
    private val infoRx = Regex("""(?i)\binfo\s*:?\s*([^\n]+?)(?=\s+(?:avl|avbl|bal)\b|[;]|\.\s|\s*$)""")
    private val byFromRx = Regex(
        """(?i)\b(?:by|from)\s+(?!(?:a/?c|ac|acct|account|your|you|ur)\b)([^\n]+?)""" + stopAhead()
    )

    private val timeLike = Regex("""^\d{1,2}[:.]\d{2}""")

    fun isBankSender(sender: String): Boolean {
        val s = sender.trim()
        if (s.isEmpty()) return false
        // personal mobile numbers are not banks
        return !Regex("""^\+?\d{6,}$""").matches(s)
    }

    fun bankFromSender(sender: String): String? {
        val parts = sender.trim().uppercase().split('-').filter { it.isNotBlank() }
        if (parts.isEmpty()) return null
        val core = parts.lastOrNull { it.length > 1 } ?: return null
        if (core.all { it.isDigit() }) return null
        val map = listOf(
            "HDFC" to "HDFC", "SBI" to "SBI", "ICICI" to "ICICI", "AXIS" to "Axis", "KOTAK" to "Kotak",
            "KMB" to "Kotak", "PNB" to "PNB", "BOB" to "BoB", "BARODA" to "BoB", "CANBNK" to "Canara",
            "CANARA" to "Canara", "UNION" to "Union", "UBI" to "Union", "IDFC" to "IDFC", "YES" to "Yes",
            "INDUS" to "IndusInd", "FED" to "Federal", "AUBANK" to "AU", "PAYTM" to "Paytm", "IDBI" to "IDBI",
            "BOI" to "BOI", "CBI" to "Central", "CENTBK" to "Central", "MAHABK" to "BoM", "BOM" to "BoM",
            "SARASWAT" to "Saraswat", "DBS" to "DBS", "RBL" to "RBL"
        )
        return map.firstOrNull { core.startsWith(it.first) }?.second ?: core
    }

    fun parse(body: String, sender: String = ""): ParsedSms? {
        val text = body.trim().replace(Regex("\\s*\\n\\s*"), ". ").replace(Regex("\\s+"), " ")
        if (text.isEmpty()) return null
        if (ignoreRx.containsMatchIn(text)) return null
        if (!bankCtxRx.containsMatchIn(text)) return null

        val amount = findAmount(text) ?: return null
        if (amount <= 0.0) return null

        // "credit card"/"debit card" are not direction words
        val dirText = text.replace(Regex("(?i)\\b(credit|debit)\\s+card"), "XXXX card")
        val d = debitRx.find(dirText)?.range?.first ?: Int.MAX_VALUE
        val c = creditRx.find(dirText)?.range?.first ?: Int.MAX_VALUE
        if (d == Int.MAX_VALUE && c == Int.MAX_VALUE) return null
        val type = if (d <= c) DEBIT else CREDIT

        return ParsedSms(
            amount = amount,
            type = type,
            mode = detectMode(text),
            merchant = findMerchant(text, type),
            account = accountRx.find(text)?.groupValues?.get(1),
            bank = if (sender.isNotBlank()) bankFromSender(sender) else null
        )
    }

    private val bareAmountRx = Regex(
        """(?i)\b(?:debited|credited|debit|credit|withdrawn|sent|paid|received)\s+(?:by|for|with|of)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\b"""
    )

    private fun findAmount(text: String): Double? {
        val m0 = firstCurrencyAmount(text)
        if (m0 != null) return m0
        return bareAmountRx.find(text)?.groupValues?.get(1)?.replace(",", "")?.toDoubleOrNull()
    }

    private fun firstCurrencyAmount(text: String): Double? {
        for (m in amountRx.findAll(text)) {
            val before = text.substring(maxOf(0, m.range.first - 18), m.range.first).lowercase()
            if (before.contains("bal") || before.contains("limit") || before.contains("avl")) continue
            return m.groupValues[1].replace(",", "").toDoubleOrNull() ?: continue
        }
        return null
    }

    fun detectMode(text: String): String {
        val t = text.lowercase()
        return when {
            Regex("""\batm\b|cash withdrawal|withdrawn""").containsMatchIn(t) -> "ATM"
            Regex("""\bupi\b|\bvpa\b|@[a-z]{2,}""").containsMatchIn(t) -> "UPI"
            Regex("""\bcard\b|\bpos\b""").containsMatchIn(t) -> "CARD"
            t.contains("neft") -> "NEFT"
            t.contains("imps") -> "IMPS"
            t.contains("rtgs") -> "RTGS"
            Regex("""net ?banking|netbanking""").containsMatchIn(t) -> "NETBANKING"
            else -> "OTHER"
        }
    }

    private fun findMerchant(text: String, type: String): String {
        val order = if (type == DEBIT)
            listOf(vpaRx, upiPathRx, iciciRx, trfToRx, toRx, atRx, infoRx, anyVpaRx)
        else
            listOf(vpaRx, upiPathRx, infoRx, byFromRx, anyVpaRx)
        for (rx in order) {
            for (m in rx.findAll(text)) {
                val cand = clean(m.groupValues[1])
                if (valid(cand)) return cand
            }
        }
        return "Unknown"
    }

    private fun clean(s: String): String {
        var r = s.trim().trim('.', ',', ';', ':', '-', '/', '(', ')', ' ')
        r = r.replace(Regex("(?i)^(m/s\\.?|vpa|mr\\.?|mrs\\.?|ms\\.?)\\s+"), "")
        r = r.replace(Regex("\\s+"), " ")
        if (r.length > 40) r = r.substring(0, 40).trim()
        return r
    }

    private fun valid(s: String): Boolean {
        if (s.length < 2) return false
        if (s.count { it.isLetter() } < 2) return false
        if (timeLike.containsMatchIn(s)) return false
        val l = s.lowercase()
        if (l.startsWith("a/c") || l.startsWith("ac ") || l.startsWith("your") || l.startsWith("xx")) return false
        if (Regex("""^(rs\.?|inr|₹)""").containsMatchIn(l)) return false
        if (l.contains("bank a/c") || l.contains("bank ac") || l.contains("a/c x") || l.contains("account x")) return false
        return true
    }

    /** Normalised key used to remember merchant -> category. */
    fun merchantKey(merchant: String): String {
        if (merchant.equals("Unknown", true)) return ""
        var m = merchant.lowercase()
        if (m.contains('@')) m = m.substringBefore('@')
        m = m.filter { it.isLetter() }
        return m.take(24)
    }
}
