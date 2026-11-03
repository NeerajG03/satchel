package app.satchel.capture

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException

/** What one step of sending came to. The queue decides what to do next from this alone. */
sealed interface Step {
    /** Done, including the cases where a retry finds the work already done. */
    data object Done : Step
    /** Worth trying again later: no network, a server hiccup, an expired token. */
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
        val request = supabase("/rest/v1/rpc/add_shelf_item", it)
            .post(body.toString().toRequestBody(json)).build()
        http.newCall(request).execute().use { response ->
            val text = response.body.string()
            when {
                response.isSuccessful -> Step.Done
                response.code == 401 -> Step.Later("signed out")
                // Same id, same thing: the database hands the row back, so a
                // conflict means the id was used for something else.
                text.contains("satchel:conflict:shelf_request") -> Step.Never("this capture clashes with one already on your Shelf")
                response.code >= 500 -> Step.Later("Satchel answered ${response.code}")
                else -> Step.Never("Satchel refused it (${response.code})")
            }
        }
    }

    suspend fun upload(item: QueuedItem, bytes: ByteArray): Step = call {
        val path = item.objectPath ?: return@call Step.Done
        val request = supabase("/storage/v1/object/shelf/$path", it)
            .header("x-upsert", "false")
            .post(bytes.toRequestBody(item.mime!!.toMediaType())).build()
        http.newCall(request).execute().use { response ->
            val text = response.body.string()
            when {
                response.isSuccessful -> Step.Done
                // The file is already there from an earlier try that lost its answer.
                response.code == 409 || text.contains("Duplicate") || text.contains("already exists") -> Step.Done
                response.code == 401 || text.contains("\"statusCode\":\"401\"") -> Step.Later("signed out")
                response.code >= 500 -> Step.Later("storage answered ${response.code}")
                else -> Step.Never("the file was refused (${response.code})")
            }
        }
    }

    /** Asks Satchel to read the item. "Already read or being read" is success. */
    suspend fun describe(item: QueuedItem): Step = call {
        val body = JSONObject().put("action", "describe").put("id", item.id)
        val request = Request.Builder().url("$satchelUrl/api/shelf")
            .header("authorization", "Bearer $it")
            .post(body.toString().toRequestBody(json)).build()
        http.newCall(request).execute().use { response ->
            when (response.code) {
                200, 409 -> Step.Done
                401 -> Step.Later("signed out")
                404 -> Step.Never("it is no longer on your Shelf")
                // Saved but not read. Each retry pays for another model call,
                // so the queue caps these.
                502 -> Step.Later("Satchel could not read it")
                else -> if (response.code >= 500) Step.Later("Satchel answered ${response.code}")
                        else Step.Never("Satchel refused it (${response.code})")
            }
        }
    }

    private suspend fun call(block: (String) -> Step): Step = withContext(Dispatchers.IO) {
        val access = token() ?: return@withContext Step.Later("signed out")
        try { block(access) } catch (e: IOException) { Step.Later("no connection") }
    }

    private fun supabase(path: String, access: String) = Request.Builder().url(supabaseUrl + path)
        .header("apikey", supabaseKey)
        .header("authorization", "Bearer $access")
}
