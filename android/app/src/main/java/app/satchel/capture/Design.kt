package app.satchel.capture

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Satchel's tokens (design/tokens.css), for the phone. Hardware is the frame and
// the keys; paper is where the person's things sit. The two never share a surface.
val Hw = Color(0xFF26231F)
val HwKey = Color(0xFF332E28)
val HwText = Color(0xFFEEE7DB)
val HwMuted = Color(0xFFA79E90)
val Paper = Color(0xFFF4F0E7)
val Paper2 = Color(0xFFEDE7DB)
val Paper3 = Color(0xFFE4DCCD)
val CardPaper = Color(0xFFFBF8F2)
val Ink = Hw
val InkText = Color(0xFF1F1B17)
val Muted = Color(0xFF6B6257)
val Line = Color(0xFFD9D1C4)
val Orange = Color(0xFFE4571E)
val Accent = Color(0xFFB8451A)
val Red = Color(0xFFA82720)
val Green = Color(0xFF2E7A4A)
val LedGreen = Color(0xFF3E9E62)
val LedAmber = Color(0xFFE2A11E)
val LedRed = Color(0xFFC8442E)
val LedOff = Color(0xFF6E665C)

private fun variable(id: Int, weight: Int) = Font(id, FontWeight(weight), variationSettings = FontVariation.Settings(FontVariation.weight(weight)))

/** What the person wrote, and headings. */
val Content = FontFamily(variable(R.font.newsreader, 400), variable(R.font.newsreader, 500))
/** The interface. */
val Ui = FontFamily(variable(R.font.instrument_sans, 400), variable(R.font.instrument_sans, 600))
/** Readouts and numbers only, never an action. */
val Mono = FontFamily(Font(R.font.dm_mono, FontWeight.Normal), Font(R.font.dm_mono_medium, FontWeight.Medium))
/** The wordmark, nowhere else. */
val Mark = FontFamily(variable(R.font.caveat, 600))

/** Four sizes, two weights: 28 for a page, 20 for a block, 16 to read, 13 for the fine print and readouts. */
object Type {
    val page = TextStyle(fontFamily = Content, fontSize = 28.sp, lineHeight = 32.sp)
    val block = TextStyle(fontFamily = Content, fontSize = 20.sp, lineHeight = 26.sp)
    val words = TextStyle(fontFamily = Content, fontSize = 16.sp, lineHeight = 24.sp)
    val body = TextStyle(fontFamily = Ui, fontSize = 16.sp, lineHeight = 22.sp)
    val key = TextStyle(fontFamily = Ui, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
    val fine = TextStyle(fontFamily = Ui, fontSize = 13.sp, lineHeight = 18.sp)
    val readout = TextStyle(fontFamily = Mono, fontSize = 13.sp, letterSpacing = 1.sp)
    val figure = TextStyle(fontFamily = Mono, fontSize = 28.sp, lineHeight = 30.sp)
}

@Composable
fun SatchelTheme(content: @Composable () -> Unit) = MaterialTheme(
    colorScheme = lightColorScheme(primary = InkText, onPrimary = Paper, background = Paper, surface = Paper,
        onBackground = InkText, onSurface = InkText, error = Red, surfaceContainer = Paper),
    typography = Typography(bodyLarge = Type.body, bodyMedium = Type.body, bodySmall = Type.fine, labelLarge = Type.key,
        titleLarge = Type.block, headlineSmall = Type.page),
    content = content,
)

/** A light never stands alone: it always sits next to its word. */
@Composable
fun Led(color: Color, word: String, modifier: Modifier = Modifier, wordColor: Color = HwMuted) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(8.dp).drawBehind { drawCircle(color.copy(alpha = .35f), radius = size.minDimension) }
            .clip(CircleShape).background(color))
        Text(word.uppercase(), style = Type.readout, color = wordColor)
    }
}

/**
 * A raised key on the hardware: it drops a pixel when pressed. Selected is
 * orange with ink text, the only place orange is a fill.
 */
@Composable
fun HardwareKey(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, selected: Boolean = false,
                height: Dp = 44.dp, light: Color? = null, description: String? = null) {
    val press = remember { MutableInteractionSource() }
    val down by press.collectIsPressedAsState()
    Box(modifier.height(height).offset(y = if (down) 1.dp else 0.dp)
        .shadow(if (down) 0.dp else 1.dp, RoundedCornerShape(9.dp))
        .clip(RoundedCornerShape(9.dp))
        .background(if (selected) Orange else HwKey)
        .drawBehind { drawLine(Color.White.copy(alpha = if (selected) .2f else .07f), Offset(8f, 1f), Offset(size.width - 8f, 1f), 2f) }
        .clickable(press, null, role = Role.Button, onClickLabel = description, onClick = onClick)
        .padding(horizontal = 16.dp), contentAlignment = Alignment.Center) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            light?.let { Box(Modifier.size(10.dp).drawBehind { drawCircle(it.copy(alpha = .4f), radius = size.minDimension) }.clip(CircleShape).background(it)) }
            Text(label, style = if (selected || light != null) Type.key else Type.body, color = if (selected) InkText else HwText)
        }
    }
}

/** A readout pill on paper: mono, upper case, outlined. Tappable when it has somewhere to go. */
@Composable
fun Chip(label: String, onClick: () -> Unit, quiet: Boolean = false) {
    Text(label.uppercase(), style = Type.readout, color = if (quiet) Muted else InkText,
        modifier = Modifier.clip(RoundedCornerShape(999.dp)).clickable(onClick = onClick)
            .background(Paper).padding(1.dp).clip(RoundedCornerShape(999.dp)).background(Paper)
            .drawBehind { drawRoundRect(Line, cornerRadius = androidx.compose.ui.geometry.CornerRadius(size.height / 2),
                style = androidx.compose.ui.graphics.drawscope.Stroke(2f)) }
            .padding(horizontal = 12.dp, vertical = 8.dp))
}
