const { createRequire } = require('node:module');
const { AndroidConfig, withAndroidManifest, withMainActivity } = require('expo/config-plugins');
const expoRequire = createRequire(require.resolve('expo/config-plugins'));
const { mergeContents } = expoRequire('@expo/config-plugins/build/utils/generateCode');

// RN 0.88 detects font changes by comparing the pixel size of 1sp. Android's
// nonlinear scaling can leave 1sp unchanged, so explicitly remeasure the surface.
// DeviceInfo separately caches fontScale until resume; refresh only that module
// so responsive JS layouts update without faking a whole-app lifecycle event.
// Expo DOM WebViews also retain their initial textZoom. Update it without reload
// so document selection, collaboration and pending edits stay in the same view.
const refreshFontScale = `  override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
    super.onConfigurationChanged(newConfig)
    reactDelegate?.reactRootView?.requestLayout()
    refreshWebViewTextZoom(reactDelegate?.reactRootView, newConfig.fontScale)
    val context = (application as com.facebook.react.ReactApplication).reactHost?.currentReactContext
    (context?.getNativeModule("DeviceInfo") as? com.facebook.react.bridge.LifecycleEventListener)?.onHostResume()
  }

  private fun refreshWebViewTextZoom(view: android.view.View?, fontScale: Float) {
    if (view is android.webkit.WebView) {
      view.settings.textZoom = kotlin.math.round(fontScale * 100).toInt()
    } else if (view is android.view.ViewGroup) {
      for (index in 0 until view.childCount) refreshWebViewTextZoom(view.getChildAt(index), fontScale)
    }
  }
`;

module.exports = function withAndroidFontScale(config) {
  config = withAndroidManifest(config, (config) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(config.modResults);
    const changes = new Set((activity.$['android:configChanges'] ?? '').split('|').filter(Boolean));
    // Keep the current route and unsaved React state when Android changes text size.
    changes.add('fontScale');
    activity.$['android:configChanges'] = [...changes].join('|');
    return config;
  });

  return withMainActivity(config, (config) => {
    if (config.modResults.language !== 'kt') {
      throw new Error('with-android-font-scale requires the Expo Kotlin MainActivity template.');
    }
    config.modResults.contents = mergeContents({
      src: config.modResults.contents,
      newSrc: refreshFontScale,
      tag: 'companybot-font-scale',
      anchor: /class MainActivity : ReactActivity\(\) \{/,
      offset: 1,
      comment: '//',
    }).contents;
    return config;
  });
};
