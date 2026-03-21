package app.octop.watch

import android.content.Context

data class WatchSettings(
  val gatewayUrl: String = "",
  val loginId: String = "",
  val bridgeId: String = ""
)

class WatchPreferences(context: Context) {
  private val prefs = context.getSharedPreferences("octop.watch.settings", Context.MODE_PRIVATE)

  fun read(): WatchSettings {
    return WatchSettings(
      gatewayUrl = prefs.getString("gatewayUrl", "") ?: "",
      loginId = prefs.getString("loginId", "") ?: "",
      bridgeId = prefs.getString("bridgeId", "") ?: ""
    )
  }

  fun save(settings: WatchSettings) {
    prefs.edit()
      .putString("gatewayUrl", settings.gatewayUrl)
      .putString("loginId", settings.loginId)
      .putString("bridgeId", settings.bridgeId)
      .apply()
  }
}
