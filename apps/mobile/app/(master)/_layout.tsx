import { Stack } from 'expo-router';

export default function MasterLayout(): React.JSX.Element {
  return <Stack screenOptions={{ headerShown: false }} />;
}
