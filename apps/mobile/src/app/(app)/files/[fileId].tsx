import { useLocalSearchParams } from 'expo-router';
import { FileScreen } from '@/features/drive/FileScreen';
export default function Route() { const { fileId } = useLocalSearchParams<{ fileId: string }>(); return <FileScreen key={fileId} fileId={fileId} />; }
