import { Stack } from 'expo-router';

export default function SharedLayout(): React.JSX.Element {
  return <Stack screenOptions={{ headerShown: false }} />;
}
