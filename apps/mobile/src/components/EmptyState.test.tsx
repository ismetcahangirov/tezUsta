import { render, screen } from '@testing-library/react-native';

import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { ImageIcon } from './icons';

describe('EmptyState', () => {
  it('shows the title it was given', async () => {
    await render(<EmptyState title="Heç nə tapılmadı" />);

    expect(screen.getByText('Heç nə tapılmadı')).toBeOnTheScreen();
  });

  it('shows a description only when there is one', async () => {
    await render(<EmptyState title="Heç nə tapılmadı" />);
    expect(screen.queryByText('Yenidən cəhd edin')).not.toBeOnTheScreen();

    await render(<EmptyState title="Heç nə tapılmadı" description="Yenidən cəhd edin" />);
    expect(screen.getByText('Yenidən cəhd edin')).toBeOnTheScreen();
  });

  it('renders an action when one is supplied', async () => {
    await render(
      <EmptyState
        title="Heç nə tapılmadı"
        action={<Button label="Yenilə" onPress={jest.fn()} />}
      />,
    );

    expect(screen.getByRole('button', { name: 'Yenilə' })).toBeOnTheScreen();
  });

  it('draws an icon above the title, which a screen reader skips', async () => {
    await render(
      <EmptyState title="Hələ paylaşım yoxdur" icon={<ImageIcon size="lg" tone="text-muted" />} />,
    );

    expect(JSON.stringify(screen.toJSON())).toContain('lucide lucide-image');
    expect(screen.getByText('Hələ paylaşım yoxdur')).toBeOnTheScreen();
    expect(screen.queryByRole('image')).not.toBeOnTheScreen();
  });
});
