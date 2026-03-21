package app.octop.watch

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class RecentNotification(
  val title: String,
  val body: String,
  val receivedAt: String,
  val launchUrl: String
)

class RecentNotificationStore(context: Context) {
  private val prefs = context.getSharedPreferences("octop.watch.notifications", Context.MODE_PRIVATE)

  fun append(notification: RecentNotification) {
    val current = read().toMutableList()
    current.add(0, notification)
    val clipped = current.take(10)
    val array = JSONArray()

    for (item in clipped) {
      array.put(JSONObject().apply {
        put("title", item.title)
        put("body", item.body)
        put("receivedAt", item.receivedAt)
        put("launchUrl", item.launchUrl)
      })
    }

    prefs.edit().putString("items", array.toString()).apply()
  }

  fun read(): List<RecentNotification> {
    val raw = prefs.getString("items", "[]") ?: "[]"
    val array = JSONArray(raw)
    return buildList {
      for (index in 0 until array.length()) {
        val item = array.optJSONObject(index) ?: continue
        add(
          RecentNotification(
            title = item.optString("title"),
            body = item.optString("body"),
            receivedAt = item.optString("receivedAt"),
            launchUrl = item.optString("launchUrl")
          )
        )
      }
    }
  }
}
