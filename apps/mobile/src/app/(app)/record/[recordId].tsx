import { useLocalSearchParams } from 'expo-router';
import { RecordScreen } from '@/features/records/RecordScreen';
export default function Route() { const { recordId } = useLocalSearchParams<{ recordId: string }>(); return <RecordScreen recordId={recordId} />; }
