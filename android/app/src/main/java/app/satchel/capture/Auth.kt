package app.satchel.capture

import android.content.Context
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.browser.customtabs.CustomTabsIntent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

const val REDIRECT = "satchel://auth/callback"

data class Session(val access: String, val refresh: String, val expiresAt: Long, val userId: String)

/**
 * The person's own Supabase session, the same kind the web app holds.
 *
 * One instance for the whole app, and every refresh goes through one lock:
 * Supabase rotates the refresh token on each use, so two refreshes at once
 * would leave one of them holding a dead token and sign the person out.
 */
class Auth(context: Context, private val http: OkHttpClient) {
    private val prefs = context.getSharedPreferences("auth", Context.MODE_PRIVATE)
    private val lock = Mutex()
    private val json = "application/json".toMediaType()

    val signedIn get() = load() != null
    val userId get() = load()?.userId

    fun startSignIn(context: Context) {
        val verifier = Base64.encodeToString(ByteArray(48).also { SecureRandom().nextBytes(it) }, URL_SAFE)
        prefs.edit().putString("verifier", verifier).apply()
        val challenge = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()), URL_SAFE)
        val url = Uri.parse("${BuildConfig.SUPABASE_URL}/auth/v1/authorize").buildUpon()
            .appendQueryParameter("provider", "github")
            .appendQueryParameter("redirect_to", REDIRECT)
            .appendQueryParameter("code_challenge", challenge)
            .appendQueryParameter("code_challenge_method", "s256")
            .build()
        CustomTabsIntent.Builder().build().launchUrl(context, url)
    }

    /** The code GitHub sign-in sent back, swapped for a session. Null and a reason on failure. */
    suspend fun finishSignIn(code: String): String? = withContext(Dispatchers.IO) {
        val verifier = prefs.getString("verifier", null) ?: return@withContext "Start the sign-in again from the app."
        val body = JSONObject().put("auth_code", code).put("code_verifier", verifier)
        val result = token("pkce", body)
        prefs.edit().remove("verifier").apply()
        result
    }

    /** A token good for at least another minute, refreshed if needed. Null when signed out. */
    suspend fun accessToken(): String? = lock.withLock {
        val session = load() ?: return null
        if (session.expiresAt - System.currentTimeMillis() / 1000 > 60) return session.access
        withContext(Dispatchers.IO) { token("refresh_token", JSONObject().put("refresh_token", session.refresh)) }
        load()?.access
    }

    fun signOut() { prefs.edit().clear().apply() }

    /** Returns null on success or a reason. Only a refusal clears the session; a dropped connection keeps it. */
    private fun token(grant: String, body: JSONObject): String? {
        val request = Request.Builder().url("${BuildConfig.SUPABASE_URL}/auth/v1/token?grant_type=$grant")
            .header("apikey", BuildConfig.SUPABASE_KEY)
            .post(body.toString().toRequestBody(json)).build()
        return try {
            http.newCall(request).execute().use { response ->
                val text = response.body.string()
                if (!response.isSuccessful) {
                    if (response.code in 400..499) signOut()
                    return "Satchel did not accept the sign-in (${response.code}). Sign in again."
                }
                val o = JSONObject(text)
                save(Session(o.getString("access_token"), o.getString("refresh_token"),
                    o.optLong("expires_at", System.currentTimeMillis() / 1000 + o.optLong("expires_in", 3600)),
                    o.getJSONObject("user").getString("id")))
                null
            }
        } catch (e: IOException) { "No connection. Try again when you are online." }
    }

    private fun save(session: Session) {
        val plain = JSONObject().put("access", session.access).put("refresh", session.refresh)
            .put("expiresAt", session.expiresAt).put("userId", session.userId).toString()
        prefs.edit().putString("session", Sealed.seal(plain)).apply()
    }

    private fun load(): Session? = prefs.getString("session", null)?.let { sealed ->
        runCatching {
            val o = JSONObject(Sealed.open(sealed))
            Session(o.getString("access"), o.getString("refresh"), o.getLong("expiresAt"), o.getString("userId"))
        }.getOrNull()
    }

    private companion object { const val URL_SAFE = Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP }
}

/** Encrypts with a key that lives in the phone's secure key store and never leaves it. */
private object Sealed {
    private const val ALIAS = "satchel-session"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    fun seal(plain: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        return Base64.encodeToString(cipher.iv + cipher.doFinal(plain.toByteArray()), Base64.NO_WRAP)
    }
    fun open(sealed: String): String {
        val raw = Base64.decode(sealed, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            .apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12)) }
        return String(cipher.doFinal(raw, 12, raw.size - 12))
    }
}
