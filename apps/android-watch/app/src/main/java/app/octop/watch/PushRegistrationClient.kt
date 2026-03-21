package app.octop.watch

import android.os.Build
import org.json.JSONObject
import java.io.BufferedReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URLEncoder
import java.net.URL

class PushRegistrationClient {
  fun register(settings: WatchSettings, token: String): String {
    require(settings.gatewayUrl.isNotBlank()) { "Gateway URL이 필요합니다." }
    require(settings.loginId.isNotBlank()) { "Login ID가 필요합니다." }
    require(settings.bridgeId.isNotBlank()) { "Bridge ID가 필요합니다." }
    require(token.isNotBlank()) { "워치 푸시 토큰이 필요합니다." }

    val normalizedBaseUrl = settings.gatewayUrl.trim().trimEnd('/')
    val endpoint =
      "$normalizedBaseUrl/api/push/subscriptions?login_id=${encode(settings.loginId.trim())}" +
        "&bridge_id=${encode(settings.bridgeId.trim())}" +
        "&app_id=android-watch"
    val payload = JSONObject().apply {
      put("deviceToken", token)
      put("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
      put("installationId", token.takeLast(24))
      put("nativePlatform", "wearos")
      put("packageName", "app.octop.watch")
      put("clientMode", "standalone")
    }

    val connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
      requestMethod = "POST"
      connectTimeout = 10_000
      readTimeout = 10_000
      doOutput = true
      setRequestProperty("Content-Type", "application/json; charset=utf-8")
    }

    OutputStreamWriter(connection.outputStream, Charsets.UTF_8).use { writer ->
      writer.write(payload.toString())
    }

    val statusCode = connection.responseCode
    val body = readBody(connection, statusCode in 200..299)
    check(statusCode in 200..299) { "등록 실패($statusCode): $body" }
    return body
  }

  private fun readBody(connection: HttpURLConnection, useInput: Boolean): String {
    val stream = if (useInput) connection.inputStream else connection.errorStream
    if (stream == null) {
      return ""
    }

    return BufferedReader(stream.reader()).use { reader ->
      buildString {
        var line = reader.readLine()
        while (line != null) {
          append(line)
          line = reader.readLine()
        }
      }
    }
  }

  private fun encode(value: String): String {
    return URLEncoder.encode(value, Charsets.UTF_8.name())
  }
}
