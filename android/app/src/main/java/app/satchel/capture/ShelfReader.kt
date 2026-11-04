package app.satchel.capture

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException

data class ShelfEntry(
    val id: String, val kind: String, val note: String, val objectPath: String?, val voicePath: String?,
    val description: String?, val transcript: String?, val status: String, val createdAt: String,
    val profile: String?, val topicName: String?,
)
data class Waiting(val id: String, val kind: String, val title: String, val profile: String?, val when_: String?, val source: String)
data class Coming(val profile: String, val kind: String, val title: String, val at: String?, val day: String?)
data class Week(val items: List<Coming>, val linked: List<String>, val failed: List<String>)

/** A sentence to show the person as it is. */
class ShelfProblem(message: String) : Exception(message)

/**
 * Reading the Shelf from the phone: the same routines and endpoints the web
 * page uses, as the person, on their own token. Nothing is kept on the phone
 * except what is on screen.
 */
class ShelfReader(private val http: OkHttpClient, private val token: suspend () -> String?) {
    private val json = "application/json".toMediaType()
    private val supabase = BuildConfig.SUPABASE_URL
    private val satchel = BuildConfig.SATCHEL_URL

    suspend fun items(): List<ShelfEntry> = rows(rpc("list_shelf_items", JSONObject().put("p_limit", 100))).map(::entry)

    suspend fun search(q: String): List<ShelfEntry> =
        rows(JSONObject(api("/api/shelf", JSONObject().put("action", "search").put("q", q))).getJSONArray("items").toString()).map(::entry)

    suspend fun waiting(): List<Waiting> = rows(rpc("list_shelf_suggestions", JSONObject())).map { o ->
        Waiting(o.getString("id"), o.getString("kind"), o.getString("title"), o.str("profile"),
            o.str("starts_at") ?: o.str("due_date"), o.optString("source"))
    }

    suspend fun dismiss(id: String) { rpc("decide_shelf_suggestion", JSONObject().put("p_id", id).put("p_status", "dismissed")) }

    /** Adds a suggestion to the profile's Google account. Returns "task" or "event". */
    suspend fun addToGoogle(id: String, profile: String): String =
        JSONObject(api("/api/google", JSONObject().put("action", "add").put("id", id).put("profile", profile))).optString("kind")

    suspend fun week(): Week {
        val o = JSONObject(api("/api/google", JSONObject().put("action", "upcoming")))
        val items = rows(o.getJSONArray("items").toString()).map {
            Coming(it.getString("profile"), it.getString("kind"), it.getString("title"), it.str("at"), it.str("day"))
        }
        fun list(key: String) = o.optJSONArray(key)?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
        return Week(items, list("linked"), list("failed"))
    }

    /** Links to the files on screen, good for an hour. */
    suspend fun links(paths: List<String>): Map<String, String> {
        if (paths.isEmpty()) return emptyMap()
        val body = JSONObject().put("expiresIn", 3600).put("paths", JSONArray(paths))
        val text = send(Request.Builder().url("$supabase/storage/v1/object/sign/shelf").supabase()
            .post(body.toString().toRequestBody(json)))
        return rows(text).mapNotNull { o -> o.str("signedURL")?.let { o.getString("path") to "$supabase/storage/v1$it" } }.toMap()
    }

    suspend fun bytes(url: String): ByteArray = withContext(Dispatchers.IO) {
        http.newCall(Request.Builder().url(url).build()).execute().use { r ->
            if (!r.isSuccessful) throw ShelfProblem("The file did not load.")
            r.body.bytes()
        }
    }

    private suspend fun rpc(name: String, body: JSONObject): String =
        send(Request.Builder().url("$supabase/rest/v1/rpc/$name").supabase().post(body.toString().toRequestBody(json)))

    private suspend fun api(path: String, body: JSONObject): String =
        send(Request.Builder().url("$satchel$path").post(body.toString().toRequestBody(json)))

    private fun Request.Builder.supabase() = header("apikey", BuildConfig.SUPABASE_KEY)

    private suspend fun send(builder: Request.Builder): String = withContext(Dispatchers.IO) {
        val access = token() ?: throw ShelfProblem("Sign in again to see your Shelf.")
        try {
            http.newCall(builder.header("authorization", "Bearer $access").build()).execute().use { r ->
                val text = r.body.string()
                if (r.isSuccessful) return@use text
                // The server's own sentence when it sent one; it is written for the person.
                val said = runCatching { JSONObject(text).optString("error") }.getOrNull()?.takeIf { it.isNotBlank() && it.contains(' ') }
                throw ShelfProblem(when {
                    r.code == 401 -> "Sign in again to see your Shelf."
                    said != null -> said
                    r.code >= 500 -> "Satchel is busy. Pull to try again."
                    else -> "Satchel could not do that. Try again."
                })
            }
        } catch (e: IOException) { throw ShelfProblem("No connection. Your Shelf shows when you are back online.") }
    }

    private fun rows(text: String): List<JSONObject> = JSONArray(text).let { a -> (0 until a.length()).map { a.getJSONObject(it) } }

    private fun entry(o: JSONObject) = ShelfEntry(o.getString("id"), o.getString("kind"), o.optString("note"), o.str("object_path"),
        o.str("voice_path"), o.str("description"), o.str("transcript"), o.optString("status"), o.optString("created_at"),
        o.str("profile"), o.str("topic_name"))
}

private fun JSONObject.str(key: String): String? = if (isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }
