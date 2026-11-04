package app.satchel.capture

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.io.IOException

/** What one step of sending came to. The queue decides what to do next from this alone. */
sealed interface Step {
    /** Done, including the cases where a retry finds the work already done. */
    data object Done : Step
    /** No usable sign-in: nothing more can be sent until the person signs in again. */
    data object SignedOut : Step
    /** Worth trying again later: no network, a server hiccup. */
    data class Later(val why: String) : Step
    /** Trying again cannot help. */
    data class Never(val why: String) : Step
}

/**
 * The same three calls the web page makes: add the row, upload the file, ask
 * for the read. Every call runs as the person, on their own token, so the
 * database's own rules decide what is allowed.
 */
class ShelfApi(
    private val http: OkHttpClient,
    private val supabaseUrl: String,
    private val supabaseKey: String,
    private val satchelUrl: String,
    private val token: suspend () -> String?,
) {
    private val json = "application/json".toMediaType()

    suspend fun add(item: QueuedItem): Step = call {
        val body = JSONObject()
            .put("p_id", item.id)
            .put("p_kind", item.kind)
            .put("p_note", item.note)
            .put("p_object_path", item.objectPath ?: JSONObject.NULL)
            .put("p_mime_type", item.mime ?: JSONObject.NULL)
            .put("p_size_bytes", item.size ?: JSONObject.NULL)
        // Only sent when there is one, so the call stays the one the database has always taken.
        if (item.voicePath != null) body.put("p_voice_path", item.voicePath).put("p_voice_mime", item.voiceMime).put("p_voice_size", item.voiceSize)
        val request = supabase("/rest/v1/rpc/add_shelf_item", it)
            .post(body.toString().toRequestBody(json)).build()
        http.newCall(request).execute().use { response ->
            val error = errorOf(response.body.string())
            when {
                response.isSuccessful -> Step.Done
                response.code == 401 -> Step.SignedOut
                // Same id, same thing: the database hands the row back, so a
                // conflict means the id was used for something else.
                error.optString("hint") == "satchel:conflict:shelf_request" ->
                    Step.Never("this capture clashes with one already on your Shelf")
                else -> fallback(response.code, "Satchel")
            }
        }
    }

    /** Streams the file from the phone's storage rather than holding it in memory. */
    suspend fun upload(path: String?, mime: String?, file: File): Step = call {
        if (path == null || mime == null) return@call Step.Done
        val request = supabase("/storage/v1/object/shelf/$path", it)
            .header("x-upsert", "false")
            .post(file.asRequestBody(mime.toMediaType())).build()
        http.newCall(request).execute().use { response ->
            // Storage answers most failures as a 400 with the real status in the body.
            val error = errorOf(response.body.string())
            val status = error.optString("statusCode").toIntOrNull() ?: response.code
            when {
                response.isSuccessful -> Step.Done
                // Already there from an earlier try that lost its answer.
                status == 409 -> Step.Done
                // A stale token, not a refusal: storage says "Unauthorized" for both,
                // and only the message tells them apart.
                status == 401 || error.optString("message").contains("jwt", ignoreCase = true) -> Step.SignedOut
                else -> fallback(status, "Storage")
            }
        }
    }

    /**
     * Asks Satchel to read the item. "Already read or being read" is success,
     * and so is "could not read it": the item is on the Shelf, marked, and the
     * web page can try again. Each try costs a model call, so the phone does not.
     */
    suspend fun describe(item: QueuedItem): Step = call {
        val body = JSONObject().put("action", "describe").put("id", item.id)
        val request = Request.Builder().url("$satchelUrl/api/shelf")
            .header("authorization", "Bearer $it")
            .post(body.toString().toRequestBody(json)).build()
        http.newCall(request).execute().use { response ->
            when (response.code) {
                200, 409, 502 -> Step.Done
                401 -> Step.SignedOut
                404 -> Step.Never("it is no longer on your Shelf")
                else -> fallback(response.code, "Satchel")
            }
        }
    }

    private fun fallback(code: Int, who: String): Step =
        if (code >= 500 || code == 429) Step.Later("$who answered $code") else Step.Never("$who refused it ($code)")

    private fun errorOf(text: String): JSONObject = runCatching { JSONObject(text) }.getOrElse { JSONObject() }

    private suspend fun call(block: (String) -> Step): Step = withContext(Dispatchers.IO) {
        val access = token() ?: return@withContext Step.SignedOut
        try { block(access) } catch (e: IOException) { Step.Later("no connection") }
    }

    private fun supabase(path: String, access: String) = Request.Builder().url(supabaseUrl + path)
        .header("apikey", supabaseKey)
        .header("authorization", "Bearer $access")
}
