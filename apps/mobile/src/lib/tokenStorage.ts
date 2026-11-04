import * as SecureStore from 'expo-secure-store';

// Convex namespaces keys with the deployment URL. Encode without collisions into
// SecureStore's restricted alphabet; never move native credentials to AsyncStorage.
const keyOf = (key: string) => `companybot.${Array.from(key).map(c => c.codePointAt(0)!.toString(16)).join('-')}`;
export const tokenStorage = {
  getItem: (key: string) => SecureStore.getItemAsync(keyOf(key)),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(keyOf(key), value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(keyOf(key)),
};
