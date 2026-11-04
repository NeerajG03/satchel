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
    val profile: String?, val topicName: String?, val sortedAt: String? = null,
)
data class ListLine(val id: String, val list: String, val title: String, val detail: String?, val profile: String?,
                    val status: String, val itemIds: List<String>, val kind: String = "item", val amount: String? = null,
                    val currency: String? = null, val spentOn: String? = null)
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

    /** Changes the note; the server makes the new search vector from the new words. */
    suspend fun edit(id: String, note: String) { api("/api/shelf", JSONObject().put("action", "edit").put("id", id).put("note", note)) }

    suspend fun setProfile(id: String, profile: String?) {
        rpc("set_shelf_profile", JSONObject().put("p_id", id).put("p_kind", profile ?: JSONObject.NULL))
    }

    /** Finds to-dos and events in a read item that was never sorted. Returns how many. */
    suspend fun sort(id: String): Int = JSONObject(api("/api/shelf", JSONObject().put("action", "sort").put("id", id))).optInt("suggestions")

    /** Asks Satchel to read an item again. */
    suspend fun reread(id: String) { api("/api/shelf", JSONObject().put("action", "describe").put("id", id)) }

    /** Removes the item for good, then its files. A file left behind is only reachable by its owner. */
    suspend fun remove(id: String) {
        val gone = rows(rpc("remove_shelf_item", JSONObject().put("p_id", id))).firstOrNull()
        val paths = listOfNotNull(gone?.str("object_path"), gone?.str("voice_path"))
        if (paths.isNotEmpty()) runCatching {
            send(Request.Builder().url("$supabase/storage/v1/object/shelf").supabase()
                .delete(JSONObject().put("prefixes", JSONArray(paths)).toString().toRequestBody(json)))
        }
    }

    suspend fun lines(): List<ListLine> = rows(rpc("list_shelf_wants", JSONObject())).map { o ->
        val ids = o.optJSONArray("item_ids")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
        ListLine(o.getString("id"), o.getString("list"), o.getString("title"), o.str("detail"), o.str("profile"), o.getString("status"), ids,
            o.optString("kind", "item"), o.str("amount"), o.str("currency"), o.str("spent_on"))
    }

    suspend fun tick(id: String, done: Boolean) {
        rpc("set_shelf_want", JSONObject().put("p_id", id).put("p_status", if (done) "done" else "want"))
    }

    suspend fun moveLine(id: String, list: String) { rpc("move_shelf_want", JSONObject().put("p_id", id).put("p_list", list)) }

    suspend fun removeLine(id: String) { rpc("remove_shelf_want", JSONObject().put("p_id", id)) }

    /** Takes back the lines one drop made, unless another drop has them too. */
    suspend fun undoLines(itemId: String) { rpc("undo_shelf_wants", JSONObject().put("p_item", itemId)) }

    /** The one-time pass over drops from before lists, a few at a time. Returns lines added. */
    suspend fun listOldDrops(limit: Int = 5): Int {
        val ids = rows(rpc("shelf_items_for_lists", JSONObject().put("p_limit", limit))).map { it.getString("id") }
        return ids.sumOf { id ->
            runCatching { JSONObject(api("/api/shelf", JSONObject().put("action", "lists").put("id", id))).optInt("lines") }.getOrDefault(0)
        }
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
        o.str("profile"), o.str("topic_name"), o.str("sorted_at"))
}

private fun JSONObject.str(key: String): String? = if (isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }
