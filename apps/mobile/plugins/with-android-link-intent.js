const { createRequire } = require('node:module');
const { withMainActivity } = require('expo/config-plugins');
const expoRequire = createRequire(require.resolve('expo/config-plugins'));
const { mergeContents } = expoRequire('@expo/config-plugins/build/utils/generateCode');

// React Native forwards new intents as URL events but leaves Activity.intent at
// its launcher value. A link received before JS subscribes must also be available
// to Linking.getInitialURL(), which reads that retained intent.
module.exports = function withAndroidLinkIntent(config) {
  return withMainActivity(config, (config) => {
    if (config.modResults.language !== 'kt') {
      throw new Error('with-android-link-intent requires the Expo Kotlin MainActivity template.');
    }
    config.modResults.contents = mergeContents({
      src: config.modResults.contents,
      newSrc: `  override fun onNewIntent(intent: android.content.Intent) {
    setIntent(intent)
    super.onNewIntent(intent)
  }
`,
      tag: 'companybot-link-intent',
      anchor: /class MainActivity : ReactActivity\(\) \{/,
      offset: 1,
      comment: '//',
    }).contents;
    return config;
  });
};
