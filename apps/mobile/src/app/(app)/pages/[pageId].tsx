import { useLocalSearchParams } from 'expo-router';
import { PageScreen } from '@/features/documents/PageScreen';
export default function Route() { const { pageId } = useLocalSearchParams<{ pageId: string }>(); return <PageScreen pageId={pageId} />; }
