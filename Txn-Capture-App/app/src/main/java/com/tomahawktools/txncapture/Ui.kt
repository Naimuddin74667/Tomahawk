package com.tomahawktools.txncapture

import android.app.Activity
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT

object C {
    val PRIMARY = Color.parseColor("#1E3A8A")
    val ACCENT = Color.parseColor("#F59E0B")
    val GREEN = Color.parseColor("#15803D")
    val RED = Color.parseColor("#B91C1C")
    val TEXT = Color.parseColor("#111827")
    val MUTED = Color.parseColor("#6B7280")
    val BG = Color.parseColor("#F3F4F6")
    val CARD = Color.WHITE
    val PALETTE = intArrayOf(
        Color.parseColor("#2563EB"), Color.parseColor("#F59E0B"), Color.parseColor("#10B981"),
        Color.parseColor("#EF4444"), Color.parseColor("#8B5CF6"), Color.parseColor("#EC4899"),
        Color.parseColor("#14B8A6"), Color.parseColor("#F97316"), Color.parseColor("#84CC16"),
        Color.parseColor("#6366F1"), Color.parseColor("#0EA5E9"), Color.parseColor("#A855F7"),
        Color.parseColor("#64748B"), Color.parseColor("#D946EF")
    )
}

fun Context.dp(v: Int): Int =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

fun Context.vbox(pad: Int = 0): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.VERTICAL
    if (pad > 0) setPadding(dp(pad), dp(pad), dp(pad), dp(pad))
}

fun Context.hbox(): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
}

fun Context.label(s: String, size: Float = 14f, color: Int = C.TEXT, bold: Boolean = false): TextView =
    TextView(this).apply {
        text = s; textSize = size; setTextColor(color)
        if (bold) typeface = Typeface.DEFAULT_BOLD
    }

fun Context.card(): LinearLayout = vbox(14).apply {
    background = GradientDrawable().apply { setColor(C.CARD); cornerRadius = dp(12).toFloat() }
    elevation = dp(2).toFloat()
}

fun Context.button(s: String, primary: Boolean = true, onClick: () -> Unit): Button =
    Button(this).apply {
        text = s; isAllCaps = false
        if (!primary) {
            background = GradientDrawable().apply {
                setColor(Color.TRANSPARENT); setStroke(dp(1), C.PRIMARY); cornerRadius = dp(8).toFloat()
            }
            setTextColor(C.PRIMARY)
        }
        setOnClickListener { onClick() }
    }

fun Context.input(hint: String, value: String = "", number: Boolean = false, multi: Boolean = false): EditText =
    EditText(this).apply {
        this.hint = hint; setText(value)
        inputType = when {
            number -> InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL
            multi -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            else -> InputType.TYPE_CLASS_TEXT
        }
        if (multi) { minLines = 3; gravity = Gravity.TOP or Gravity.START }
    }

fun lp(w: Int = MATCH, h: Int = WRAP, top: Int = 0, ctx: Context? = null, weight: Float = 0f): LinearLayout.LayoutParams =
    LinearLayout.LayoutParams(w, h, weight).apply { if (ctx != null) topMargin = ctx.dp(top) }

fun LinearLayout.add(v: View, top: Int = 8): LinearLayout {
    addView(v, lp(top = top, ctx = context)); return this
}

fun Activity.toast(s: String) = android.widget.Toast.makeText(this, s, android.widget.Toast.LENGTH_SHORT).show()

/** Simple donut chart. */
class PieChartView(ctx: Context) : View(ctx) {
    private var slices: List<Pair<Double, Int>> = emptyList()
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val rect = RectF()
    var centerText: String = ""
    private val tp = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER; color = C.TEXT; typeface = Typeface.DEFAULT_BOLD
    }

    fun setData(data: List<Pair<Double, Int>>, center: String) {
        slices = data.filter { it.first > 0 }; centerText = center; invalidate()
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        val h = minOf(w, context.dp(220))
        setMeasuredDimension(w, h)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val size = minOf(width, height).toFloat()
        val stroke = size * 0.16f
        paint.strokeWidth = stroke
        val cx = width / 2f; val cy = height / 2f
        val r = size / 2f - stroke / 2f - 4
        rect.set(cx - r, cy - r, cx + r, cy + r)
        val total = slices.sumOf { it.first }
        if (total <= 0) {
            paint.color = Color.parseColor("#E5E7EB")
            canvas.drawArc(rect, 0f, 360f, false, paint)
        } else {
            var start = -90f
            for ((v, col) in slices) {
                val sweep = (v / total * 360f).toFloat()
                paint.color = col
                canvas.drawArc(rect, start, sweep, false, paint)
                start += sweep
            }
        }
        tp.textSize = size * 0.09f
        canvas.drawText(centerText, cx, cy + tp.textSize / 3, tp)
    }
}
