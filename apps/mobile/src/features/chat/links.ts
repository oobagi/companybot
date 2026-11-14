import { router, type Href } from 'expo-router';
import { Linking } from 'react-native';
import { contentDestination } from './logic';

/** Model output never executes HTML or arbitrary URL schemes. */
export async function openContentLink(href: string, databases?: { _id: string; key: string }[]) {
  const destination = contentDestination(href);
  if (destination.kind === 'external') { await Linking.openURL(destination.url); return; }
  if (destination.kind === 'database') {
    const database = databases?.find((d) => d.key === destination.key);
    if (!database) throw new Error(databases ? 'This database is no longer available.' : 'Still loading this database. Try again in a moment.');
    router.push({ pathname: '/database/[typeId]', params: { typeId: database._id } });
    return;
  }
  router.push({ pathname: destination.path, params: destination.params } as Href);
}
