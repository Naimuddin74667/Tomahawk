package com.tomahawktools.txncapture

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

data class Txn(
    val id: Long = 0,
    val ts: Long,
    val amount: Double,
    val type: String,
    val mode: String,
    val merchant: String,
    val mkey: String,
    val category: String?,
    val account: String?,
    val bank: String?,
    val isSalary: Boolean,
    val source: String,
    val raw: String?,
    val hash: String,
    val synced: Boolean = false,
    val note: String? = null
) {
    val isDebit get() = type == SmsParser.DEBIT
}

class Db private constructor(ctx: Context) : SQLiteOpenHelper(ctx, "txncapture.db", null, 1) {

    companion object {
        @Volatile private var inst: Db? = null
        fun get(ctx: Context): Db =
            inst ?: synchronized(this) { inst ?: Db(ctx.applicationContext).also { inst = it } }

        const val SELF = "Self Transfer"
        val DEFAULT_CATS = listOf(
            "Food", "Grocery", "Petrol", "Travel", "Shopping", "Bills", "EMI", "Ghar/Rent",
            "Health", "Education", "Entertainment", "Family", SELF, "Other"
        )
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE txns(
                id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, amount REAL NOT NULL,
                type TEXT NOT NULL, mode TEXT, merchant TEXT, mkey TEXT, category TEXT, account TEXT,
                bank TEXT, is_salary INTEGER DEFAULT 0, source TEXT, raw TEXT, hash TEXT UNIQUE,
                synced INTEGER DEFAULT 0, note TEXT)"""
        )
        db.execSQL("CREATE INDEX ix_ts ON txns(ts)")
        db.execSQL("CREATE TABLE merchant_map(mkey TEXT PRIMARY KEY, category TEXT NOT NULL)")
        db.execSQL("CREATE TABLE budgets(category TEXT PRIMARY KEY, amount REAL NOT NULL)")
        db.execSQL("CREATE TABLE categories(name TEXT PRIMARY KEY, sort INTEGER)")
        DEFAULT_CATS.forEachIndexed { i, c ->
            db.execSQL("INSERT INTO categories(name, sort) VALUES(?, ?)", arrayOf<Any>(c, i))
        }
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}

    // ---------- txns ----------
    private fun Cursor.str(c: String): String? = getString(getColumnIndexOrThrow(c))

    private fun read(c: Cursor) = Txn(
        id = c.getLong(c.getColumnIndexOrThrow("id")),
        ts = c.getLong(c.getColumnIndexOrThrow("ts")),
        amount = c.getDouble(c.getColumnIndexOrThrow("amount")),
        type = c.str("type") ?: SmsParser.DEBIT,
        mode = c.str("mode") ?: "OTHER",
        merchant = c.str("merchant") ?: "Unknown",
        mkey = c.str("mkey") ?: "",
        category = c.str("category"),
        account = c.str("account"),
        bank = c.str("bank"),
        isSalary = c.getInt(c.getColumnIndexOrThrow("is_salary")) == 1,
        source = c.str("source") ?: "SMS",
        raw = c.str("raw"),
        hash = c.str("hash") ?: "",
        synced = c.getInt(c.getColumnIndexOrThrow("synced")) == 1,
        note = c.str("note")
    )

    private fun values(t: Txn) = ContentValues().apply {
        put("ts", t.ts); put("amount", t.amount); put("type", t.type); put("mode", t.mode)
        put("merchant", t.merchant); put("mkey", t.mkey); put("category", t.category)
        put("account", t.account); put("bank", t.bank); put("is_salary", if (t.isSalary) 1 else 0)
        put("source", t.source); put("raw", t.raw); put("hash", t.hash)
        put("synced", if (t.synced) 1 else 0); put("note", t.note)
    }

    /** returns new id, or -1 if duplicate */
    fun insert(t: Txn): Long =
        writableDatabase.insertWithOnConflict("txns", null, values(t), SQLiteDatabase.CONFLICT_IGNORE)

    fun update(t: Txn) {
        writableDatabase.update("txns", values(t.copy(synced = false)), "id=?", arrayOf(t.id.toString()))
    }

    fun delete(id: Long) {
        writableDatabase.delete("txns", "id=?", arrayOf(id.toString()))
    }

    private fun query(where: String?, args: Array<String>?, order: String = "ts DESC", limit: String? = null): List<Txn> {
        val out = ArrayList<Txn>()
        readableDatabase.query("txns", null, where, args, null, null, order, limit).use { c ->
            while (c.moveToNext()) out.add(read(c))
        }
        return out
    }

    fun get(id: Long): Txn? = query("id=?", arrayOf(id.toString())).firstOrNull()
    fun all(): List<Txn> = query(null, null)
    fun between(start: Long, end: Long): List<Txn> =
        query("ts>=? AND ts<?", arrayOf(start.toString(), end.toString()))
    fun unsynced(): List<Txn> = query("synced=0", null, "ts ASC")

    fun markSynced(id: Long) {
        writableDatabase.execSQL("UPDATE txns SET synced=1 WHERE id=?", arrayOf<Any>(id))
    }

    fun setCategory(id: Long, cat: String?) {
        val cv = ContentValues().apply { put("category", cat); put("synced", 0) }
        writableDatabase.update("txns", cv, "id=?", arrayOf(id.toString()))
    }

    fun setSalary(id: Long, flag: Boolean) {
        val cv = ContentValues().apply { put("is_salary", if (flag) 1 else 0); put("synced", 0) }
        writableDatabase.update("txns", cv, "id=?", arrayOf(id.toString()))
    }

    /** Apply a learned category to older uncategorised debits of same merchant. */
    fun fillCategoryForMerchant(mkey: String, cat: String): Int {
        if (mkey.isBlank()) return 0
        val cv = ContentValues().apply { put("category", cat); put("synced", 0) }
        return writableDatabase.update(
            "txns", cv, "mkey=? AND category IS NULL AND type=?", arrayOf(mkey, SmsParser.DEBIT)
        )
    }

    fun salaryTimes(): List<Long> {
        val out = ArrayList<Long>()
        readableDatabase.rawQuery("SELECT ts FROM txns WHERE is_salary=1 ORDER BY ts DESC", null).use { c ->
            while (c.moveToNext()) out.add(c.getLong(0))
        }
        return out
    }

    fun spentInCategory(cat: String, start: Long, end: Long): Double {
        readableDatabase.rawQuery(
            "SELECT COALESCE(SUM(amount),0) FROM txns WHERE type=? AND category=? AND ts>=? AND ts<?",
            arrayOf(SmsParser.DEBIT, cat, start.toString(), end.toString())
        ).use { c -> return if (c.moveToFirst()) c.getDouble(0) else 0.0 }
    }

    // ---------- merchant memory ----------
    fun merchantCat(mkey: String): String? {
        if (mkey.isBlank()) return null
        readableDatabase.rawQuery("SELECT category FROM merchant_map WHERE mkey=?", arrayOf(mkey)).use { c ->
            return if (c.moveToFirst()) c.getString(0) else null
        }
    }

    fun setMerchantCat(mkey: String, cat: String) {
        if (mkey.isBlank()) return
        val cv = ContentValues().apply { put("mkey", mkey); put("category", cat) }
        writableDatabase.insertWithOnConflict("merchant_map", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
    }

    // ---------- categories ----------
    fun categories(): List<String> {
        val out = ArrayList<String>()
        readableDatabase.rawQuery("SELECT name FROM categories ORDER BY sort, name", null).use { c ->
            while (c.moveToNext()) out.add(c.getString(0))
        }
        return out
    }

    fun addCategory(name: String) {
        val cv = ContentValues().apply { put("name", name.trim()); put("sort", 50) }
        writableDatabase.insertWithOnConflict("categories", null, cv, SQLiteDatabase.CONFLICT_IGNORE)
    }

    fun deleteCategory(name: String) {
        writableDatabase.delete("categories", "name=?", arrayOf(name))
        writableDatabase.delete("budgets", "category=?", arrayOf(name))
        writableDatabase.delete("merchant_map", "category=?", arrayOf(name))
    }

    /** Most used categories (for quick notification buttons). */
    fun topCategories(n: Int): List<String> {
        val out = ArrayList<String>()
        readableDatabase.rawQuery(
            "SELECT category, COUNT(*) c FROM txns WHERE category IS NOT NULL AND type=? GROUP BY category ORDER BY c DESC LIMIT ?",
            arrayOf(SmsParser.DEBIT, n.toString())
        ).use { c -> while (c.moveToNext()) out.add(c.getString(0)) }
        for (d in listOf("Food", "Petrol", "Grocery", "Shopping")) {
            if (out.size >= n) break
            if (d !in out && d in categories()) out.add(d)
        }
        return out.take(n)
    }

    // ---------- budgets ----------
    fun budgets(): Map<String, Double> {
        val out = LinkedHashMap<String, Double>()
        readableDatabase.rawQuery("SELECT category, amount FROM budgets", null).use { c ->
            while (c.moveToNext()) out[c.getString(0)] = c.getDouble(1)
        }
        return out
    }

    fun setBudget(cat: String, amount: Double) {
        if (amount <= 0) {
            writableDatabase.delete("budgets", "category=?", arrayOf(cat)); return
        }
        val cv = ContentValues().apply { put("category", cat); put("amount", amount) }
        writableDatabase.insertWithOnConflict("budgets", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
    }
}
