package az.tezusta.googleaccountpicker

import android.accounts.AccountManager
import android.app.Activity
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Opens Android's own account chooser, limited to Google accounts, and
 * resolves to the address the user picked, or `null` if they backed out
 * (#510). It fills a form field and nothing else: no token is requested and
 * nothing is signed in with Google (ADR-0072).
 */
class GoogleAccountPickerModule : Module() {
  private var pending: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("GoogleAccountPicker")

    AsyncFunction("pick") { promise: Promise ->
      val activity = appContext.currentActivity
      // A second call while the chooser is up would orphan the first promise.
      if (activity == null || pending != null) {
        promise.resolve(null)
        return@AsyncFunction
      }
      val intent = AccountManager.newChooseAccountIntent(
        null,
        null,
        arrayOf(GOOGLE_ACCOUNT_TYPE),
        null,
        null,
        null,
        null,
      )
      pending = promise
      activity.startActivityForResult(intent, REQUEST_CODE)
    }.runOnQueue(Queues.MAIN)

    OnActivityResult { _, payload ->
      if (payload.requestCode != REQUEST_CODE) {
        return@OnActivityResult
      }
      val promise = pending ?: return@OnActivityResult
      pending = null
      val name =
        if (payload.resultCode == Activity.RESULT_OK) {
          payload.data?.getStringExtra(AccountManager.KEY_ACCOUNT_NAME)
        } else {
          null
        }
      promise.resolve(name)
    }
  }

  private companion object {
    const val GOOGLE_ACCOUNT_TYPE = "com.google"
    const val REQUEST_CODE = 0x7a31
  }
}
