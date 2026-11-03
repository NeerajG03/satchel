package app.satchel.capture

import kotlinx.coroutines.test.runTest
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.nio.file.Files

class SenderTest {
    private val server = MockWebServer()
    private val calls = mutableListOf<String>()
    private val answers = mutableMapOf<String, ArrayDeque<Int>>()
    private var token: String? = "person"
    private var uploadBody = "{}"
    private lateinit var queue: Queue
    private lateinit var sender: Sender

    private fun answer(step: String, vararg codes: Int) { answers[step] = ArrayDeque(codes.toList()) }

    @Before fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.url.encodedPath
                val step = when {
                    path.endsWith("add_shelf_item") -> "add"
                    path.startsWith("/storage/") -> "upload"
                    else -> "describe"
                }
                calls += step
                val code = answers[step]?.removeFirstOrNull() ?: 200
                val body = if (step == "upload") uploadBody else "{}"
                return MockResponse.Builder().code(code).body(body).build()
            }
        }
        server.start()
        val base = server.url("").toString().trimEnd('/')
        queue = Queue(Files.createTempDirectory("queue").toFile())
        sender = Sender(queue, ShelfApi(OkHttpClient(), base, "key", base) { token }) { "owner" }
    }

    @After fun tearDown() { server.close() }

    @Test fun `a note is added then read, with no upload`() = runTest {
        queue.addNote("call the dentist")
        assertTrue(sender.run())
        assertEquals(listOf("add", "describe"), calls)
        assertTrue(queue.pending().isEmpty())
    }

    @Test fun `a photo goes add, upload, read, in that order, into the owner's folder`() = runTest {
        val item = queue.addFile("photo", "image/jpeg", byteArrayOf(1, 2, 3))
        assertTrue(sender.run())
        assertEquals(listOf("add", "upload", "describe"), calls)
        val upload = generateSequence { server.takeRequest() }.take(3).toList()[1]
        assertEquals("/storage/v1/object/shelf/owner/${item.id}.jpg", upload.url.encodedPath)
    }

    @Test fun `a lost upload is retried from the upload, and already there counts as done`() = runTest {
        queue.addFile("voice", "audio/mp4", byteArrayOf(9))
        answer("upload", 503)
        assertFalse(sender.run())
        assertEquals(QueuedItem.UPLOAD, queue.pending().single().stage)
        answer("upload", 400)
        uploadBody = "{\"statusCode\":\"409\",\"error\":\"Duplicate\"}"
        assertTrue(sender.run())
        assertEquals(listOf("add", "upload", "upload", "describe"), calls)
        assertTrue(queue.pending().isEmpty())
    }

    @Test fun `a read is never asked for before the upload is confirmed`() = runTest {
        queue.addFile("photo", "image/jpeg", byteArrayOf(1))
        answer("upload", 500, 500)
        sender.run(); sender.run()
        assertFalse(calls.contains("describe"))
    }

    @Test fun `a read Satchel could not do is left for the web page, not retried from the phone`() = runTest {
        queue.addNote("x")
        answer("describe", 502)
        assertTrue(sender.run())
        assertTrue(queue.pending().isEmpty())
        assertEquals(1, calls.count { it == "describe" })
    }

    @Test fun `a stale token at storage waits for sign-in instead of parking the capture`() = runTest {
        queue.addFile("photo", "image/jpeg", byteArrayOf(1))
        answer("upload", 400)
        uploadBody = "{\"statusCode\":\"403\",\"error\":\"Unauthorized\",\"message\":\"jwt expired\"}"
        assertFalse(sender.run())
        assertEquals(null, queue.pending().single().problem)
    }

    @Test fun `a storage refusal is kept with its reason`() = runTest {
        queue.addFile("photo", "image/jpeg", byteArrayOf(1))
        answer("upload", 400)
        uploadBody = "{\"statusCode\":\"403\",\"error\":\"Unauthorized\",\"message\":\"new row violates row-level security policy\"}"
        assertTrue(sender.run())
        assertNotNull(queue.pending().single().problem)
    }

    @Test fun `already read is success`() = runTest {
        queue.addNote("x")
        answer("describe", 409)
        assertTrue(sender.run())
        assertTrue(queue.pending().isEmpty())
    }

    @Test fun `a refusal is kept with its reason and not retried`() = runTest {
        queue.addNote("x")
        answer("add", 400)
        assertTrue(sender.run())
        assertNotNull(queue.pending().single().problem)
        sender.run()
        assertEquals(1, calls.size)
    }

    @Test fun `a stuck item does not hold up the ones after it`() = runTest {
        queue.addFile("photo", "image/jpeg", byteArrayOf(1))
        Thread.sleep(5)
        queue.addNote("later note")
        answer("upload", 503)
        assertFalse(sender.run())
        assertEquals(listOf("add", "upload", "add", "describe"), calls)
        assertEquals(1, queue.pending().size)
    }

    @Test fun `a capture cleared from the phone mid-run is skipped, not a crash`() = runTest {
        val item = queue.addNote("x")
        queue.remove(item)
        assertTrue(sender.run())
    }

    @Test fun `signed out sends nothing and keeps everything`() = runTest {
        token = null
        queue.addNote("x")
        assertFalse(sender.run())
        assertTrue(calls.isEmpty())
        assertEquals(1, queue.pending().size)
    }

    @Test fun `the queue refuses what the Shelf cannot take`() {
        val refused = runCatching { queue.addFile("photo", "image/gif", byteArrayOf(1)) }
        assertTrue(refused.isFailure)
        assertEquals(4000, queue.addNote("a".repeat(5000)).note.length)
    }
}
