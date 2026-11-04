import { StyleSheet, Text, View } from "react-native";

export default function HomeScreen() {
  return <View style={styles.container}><Text accessibilityRole="header" style={styles.title}>Companybot</Text><Text>Mobile preview</Text><Text>Chat, workspaces, and agents are coming next.</Text></View>;
}

const styles = StyleSheet.create({ container: { flex: 1, padding: 24, gap: 12, justifyContent: "center", backgroundColor: "#fafafa" }, title: { fontSize: 32, fontWeight: "600" } });
