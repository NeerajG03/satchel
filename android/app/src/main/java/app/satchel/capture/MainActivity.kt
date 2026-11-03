package app.satchel.capture

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

val Paper = Color(0xFFF4F0E7)
val Paper2 = Color(0xFFEDE7DB)
val Ink = Color(0xFF26231F)
val InkText = Color(0xFF1F1B17)
val Muted = Color(0xFF6B6257)
val Orange = Color(0xFFE4571E)
val Accent = Color(0xFFB8451A)
val Red = Color(0xFFA82720)

@Composable
fun SatchelTheme(content: @Composable () -> Unit) = MaterialTheme(
    colorScheme = lightColorScheme(primary = InkText, onPrimary = Paper, background = Paper, surface = Paper,
        onBackground = InkText, onSurface = InkText, error = Red, secondary = Accent),
    content = content,
)

/** Sign-in, what is still waiting to send, and the three ways to capture. Reading and searching stay on the web. */
class MainActivity : ComponentActivity() {
    private var signedIn by mutableStateOf(false)
    private var message by mutableStateOf<String?>(null)
    private var waiting by mutableStateOf(listOf<QueuedItem>())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val fromHistory = intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
        if (savedInstanceState == null && !fromHistory) handle(intent)
        setContent { SatchelTheme { Home() } }
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); handle(intent) }

    override fun onResume() {
        super.onResume()
        refresh()
        // Opening the app is also a chance to send anything a strict battery saver held back.
        if (signedIn) sendSoon()
    }

    private fun refresh() { signedIn = app.auth.signedIn; waiting = app.queue.pending() }

    /** A sign-in code works once, so the link is cleared as soon as it is read. */
    private fun handle(intent: Intent?) {
        val data = intent?.data ?: return
        if (!data.toString().startsWith(REDIRECT)) return
        intent.data = null
        setIntent(intent)
        val code = data.getQueryParameter("code")
        if (code == null) {
            message = data.getQueryParameter("error_description") ?: "GitHub sign-in did not finish. Try again."
            return
        }
        message = "Signing you in…"
        lifecycleScope.launch {
            message = app.auth.finishSignIn(code)
            refresh()
            if (signedIn) sendSoon()
        }
    }

    @Composable
    private fun Home() {
        Column(Modifier.fillMaxSize().background(Paper).statusBarsPadding().navigationBarsPadding().padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("satchel", fontFamily = FontFamily.Cursive, fontSize = 34.sp, color = InkText)
            Text("Drop it here, find it later.", fontFamily = FontFamily.Serif, fontSize = 24.sp, color = InkText)
            message?.let { Text(it, color = if (it.endsWith("…")) Muted else Red) }
            if (!signedIn) {
                Text("Sign in with the GitHub account you use for Satchel. Your Shelf stays yours: only you can see it.", color = Muted)
                Button({ app.auth.startSignIn(this@MainActivity) }, Modifier.fillMaxWidth().height(52.dp)) { Text("Continue with GitHub") }
                return@Column
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                for ((label, mode) in listOf("Photo" to "photo", "Voice" to "voice", "Note" to "note"))
                    Button({ startActivity(CaptureActivity.intent(this@MainActivity, mode)) }, Modifier.weight(1f).height(56.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = Ink, contentColor = Paper)) { Text(label) }
            }
            Text(
                "For one tap from anywhere, add the Satchel widget to your home screen, or the Satchel tile to Quick Settings.",
                color = Muted, fontSize = 14.sp,
            )
            Surface(color = Paper2, shape = MaterialTheme.shapes.medium) {
                Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    val stuck = waiting.filter { it.problem != null }
                    Text(when {
                        waiting.isEmpty() -> "Everything you saved is on your Shelf."
                        stuck.size == waiting.size -> "${stuck.size} could not be sent."
                        else -> "${waiting.size - stuck.size} waiting to send. They go as soon as there is a connection."
                    }, color = InkText)
                    stuck.forEach { Text("· ${it.kind}: ${it.problem}", color = Red, fontSize = 13.sp) }
                    if (stuck.isNotEmpty()) TextButton({ stuck.forEach(app.queue::remove); refresh() }) { Text("Clear these") }
                }
            }
            OutlinedButton({ startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${BuildConfig.SATCHEL_URL}/shelf"))) },
                Modifier.fillMaxWidth()) { Text("Open your Shelf", color = InkText) }
            Spacer(Modifier.weight(1f))
            val unsent = waiting.count { it.problem == null }
            TextButton({
                stopSending(); app.queue.clear()
                lifecycleScope.launch { app.auth.signOutEverywhere() }
                refresh(); signedIn = false
            }) {
                Text(if (unsent > 0) "Sign out (removes $unsent not yet sent)" else "Sign out", color = Muted)
            }
        }
    }
}
