package app.octop.watch

import android.app.Application

class OctOPWearApplication : Application() {
  override fun onCreate() {
    super.onCreate()
    FirebaseBootstrap.initialize(this)
  }
}
