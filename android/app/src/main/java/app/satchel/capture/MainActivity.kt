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
val Red = Color(0xFFA82720)
val Green = Color(0xFF2E7A4A)
val Line = Color(0xFFD9D1C4)

@Composable
fun SatchelTheme(content: @Composable () -> Unit) = MaterialTheme(
    colorScheme = lightColorScheme(primary = InkText, onPrimary = Paper, background = Paper, surface = Paper,
        onBackground = InkText, onSurface = InkText, error = Red),
    content = content,
)

/** Sign-in, then the Shelf: what waits for a yes, the week ahead, everything dropped, and the key that opens capture. */
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
            message = data.getQueryParameter("error_description") ?: "Sign-in did not finish. Try again."
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
        if (signedIn) {
            val stuck = waiting.filter { it.problem != null }
            ShelfScreen(app.reader, unsent = waiting.size - stuck.size, stuck = stuck,
                onClearStuck = { stuck.forEach(app.queue::remove); refresh() },
                onCapture = { startActivity(CaptureActivity.intent(this, it)) },
                onSignOut = {
                    stopSending(); app.queue.clear()
                    lifecycleScope.launch { app.auth.signOutEverywhere() }
                    refresh(); signedIn = false
                })
            return
        }
        Column(Modifier.fillMaxSize().background(Paper).statusBarsPadding().navigationBarsPadding().padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("satchel", fontFamily = FontFamily.Cursive, fontSize = 34.sp, color = InkText)
            Text("Drop it here, find it later.", fontFamily = FontFamily.Serif, fontSize = 24.sp, color = InkText)
            message?.let { Text(it, color = if (it.endsWith("…")) Muted else Red) }
            Text("Sign in with the account you use for Satchel. Your Shelf stays yours: only you can see it.", color = Muted)
            Button({ app.auth.startSignIn(this@MainActivity, "google") }, Modifier.fillMaxWidth().height(52.dp)) { Text("Continue with Google") }
            TextButton({ app.auth.startSignIn(this@MainActivity, "github") }) { Text("Use GitHub instead", color = Muted) }
        }
    }
}
