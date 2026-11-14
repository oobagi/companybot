import { useLocalSearchParams } from 'expo-router';
import { DatabaseScreen } from '@/features/records/DatabaseScreen';
export default function Route() { const { typeId } = useLocalSearchParams<{ typeId: string }>(); return <DatabaseScreen typeId={typeId} />; }
