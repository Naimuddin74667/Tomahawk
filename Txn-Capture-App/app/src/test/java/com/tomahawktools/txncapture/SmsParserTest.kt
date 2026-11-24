package com.tomahawktools.txncapture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SmsParserTest {

    private fun p(body: String, sender: String = "VM-HDFCBK") = SmsParser.parse(body, sender)

    @Test fun hdfcUpiSent() {
        val r = p("Sent Rs.250.00\nFrom HDFC Bank A/C *1234\nTo ZOMATO LIMITED\nOn 24/11/26\nRef 432112345678\nNot You?\nCall 18002586161/SMS BLOCK UPI to 7308080808")!!
        assertEquals(250.0, r.amount, 0.001)
        assertEquals("DEBIT", r.type)
        assertEquals("ZOMATO LIMITED", r.merchant)
        assertEquals("1234", r.account)
        assertEquals("HDFC", r.bank)
    }

    @Test fun hdfcCredit() {
        val r = p("Money Received - INR 1,500.00 in your HDFC Bank A/c xx1234 on 24-11-26 by A/c linked to VPA ramesh.k@okaxis (UPI Ref No 432198765432)")!!
        assertEquals(1500.0, r.amount, 0.001)
        assertEquals("CREDIT", r.type)
        assertEquals("ramesh.k@okaxis", r.merchant)
    }

    @Test fun sbiUpiDebit() {
        val r = p("Dear UPI user A/C X5678 debited by 120.0 on date 24Nov26 trf to SWIGGY Refno 432155554444. If not u? call 1800111109. -SBI", "AD-SBIUPI-S")!!
        assertEquals(120.0, r.amount, 0.001)
        assertEquals("DEBIT", r.type)
        assertEquals("SWIGGY", r.merchant)
        assertEquals("SBI", r.bank)
    }

    @Test fun sbiCredit() {
        val r = p("Dear SBI User, your A/c X5678-credited by Rs.45000 on 01Nov26 transfer from ACME PVT LTD Ref No 123456 -SBI", "JD-SBIINB")!!
        assertEquals(45000.0, r.amount, 0.001)
        assertEquals("CREDIT", r.type)
        assertEquals("ACME PVT LTD", r.merchant)
        assertEquals("SBI", r.bank)
    }

    @Test fun iciciDebit() {
        val r = p("ICICI Bank Acct XX123 debited for Rs 349.00 on 24-Nov-26; AMAZON PAY credited. UPI:432100001111. Call 18002662 for dispute. SMS BLOCK 123 to 9215676766.", "VK-ICICIT-S")!!
        assertEquals(349.0, r.amount, 0.001)
        assertEquals("DEBIT", r.type)
        assertEquals("AMAZON PAY", r.merchant)
        assertEquals("ICICI", r.bank)
    }

    @Test fun axisUpi() {
        val r = p("INR 560.00 debited\nA/c no. XX4321\n24-11-26, 10:12:45\nUPI/P2M/432177778888/BPCL PETROL PUMP\nNot you? SMS BLOCKUPI Cust ID to 919951860002\nAxis Bank", "BZ-AXISBK")!!
        assertEquals(560.0, r.amount, 0.001)
        assertEquals("DEBIT", r.type)
        assertEquals("BPCL PETROL PUMP", r.merchant)
        assertEquals("UPI", r.mode)
    }

    @Test fun kotakSent() {
        val r = p("Sent Rs.80.00 from Kotak Bank AC X9876 to paytmqr281005050101@paytm on 24-11-26.UPI Ref 432166667777. Not you, https://kotak.com/KBANKT/Fraud", "AX-KOTAKB")!!
        assertEquals(80.0, r.amount, 0.001)
        assertEquals("DEBIT", r.type)
        assertTrue(r.merchant.contains("@paytm"))
        assertEquals("Kotak", r.bank)
    }

    @Test fun creditCardSpend() {
        val r = p("Thank you for using your HDFC Bank Credit Card ending 4417 for Rs 2,499.00 at FLIPKART on 2026-11-24:10:15:00. Avl Lmt: Rs 50,000")!!
        assertEquals(2499.0, r.amount, 0.001)
        assertEquals("DEBIT", r.type)
        assertEquals("FLIPKART", r.merchant)
        assertEquals("CARD", r.mode)
    }

    @Test fun atmWithdrawal() {
        val r = p("Rs.2000.00 withdrawn at ATM S1AW000123 from A/c XX1234 on 24-11-26. Avl Bal Rs.15,000.00", "VM-SBIINB")!!
        assertEquals(2000.0, r.amount, 0.001)
        assertEquals("DEBIT", r.type)
        assertEquals("ATM", r.mode)
    }

    @Test fun salaryNeft() {
        val r = p("Your A/c XX1234 is credited with INR 32,000.00 on 01-11-2026. Info: NEFT-SALARY NOV ACME. Avl Bal INR 40,210.00", "VM-HDFCBK")!!
        assertEquals(32000.0, r.amount, 0.001)
        assertEquals("CREDIT", r.type)
        assertTrue(r.merchant.uppercase().contains("SALARY"))
    }

    @Test fun ignoreOtp() {
        assertNull(p("123456 is your OTP for txn of Rs 500 at AMAZON on your HDFC card. Do not share."))
    }

    @Test fun ignoreDue() {
        assertNull(p("Your HDFC Credit Card bill of Rs 5,000 is due on 05-12-26. Minimum amount due Rs 250."))
    }

    @Test fun ignorePromo() {
        assertNull(p("Get pre-approved personal loan up to Rs 5,00,000 from HDFC Bank. Apply now"))
    }

    @Test fun ignoreCollectRequest() {
        assertNull(p("ABC has requested money from you on Google Pay UPI. On approving, Rs 500 will be debited from your account"))
    }

    @Test fun personalSender() {
        assertTrue(!SmsParser.isBankSender("+919876543210"))
        assertTrue(SmsParser.isBankSender("VM-HDFCBK"))
    }

    @Test fun merchantKey() {
        assertEquals("zomatoorder", SmsParser.merchantKey("zomato.order1@hdfcbank"))
        assertEquals("", SmsParser.merchantKey("Unknown"))
        assertNotNull(SmsParser.merchantKey("SWIGGY"))
    }
}
