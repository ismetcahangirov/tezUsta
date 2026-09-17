import { render, screen } from '@testing-library/react-native';

import { Skeleton } from './Skeleton';

describe('Skeleton', () => {
  it('hides a bare placeholder from the accessibility tree instead of reading it as an unnamed progress bar', async () => {
    const { toJSON } = await render(<Skeleton className="h-control-md" />);

    expect(screen.queryByRole('progressbar')).not.toBeOnTheScreen();
    expect(screen.queryAllByLabelText(/.+/)).toHaveLength(0);

    // The actual hiding mechanism: `accessible`/role alone is not enough to
    // keep an unlabelled placeholder out of the tree (see Skeleton.tsx), so
    // assert the props a screen reader actually reads.
    const node = toJSON();
    expect(node?.props.accessibilityElementsHidden).toBe(true);
    expect(node?.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(node?.props.accessibilityRole).toBeUndefined();
  });

  it('becomes a real accessibility element, labelled, when a caller supplies a label', async () => {
    const { toJSON } = await render(
      <Skeleton accessibilityLabel="Yüklənir" className="h-control-md" />,
    );

    expect(screen.getByLabelText('Yüklənir')).toBeOnTheScreen();

    const node = toJSON();
    expect(node?.props.accessible).toBe(true);
    expect(node?.props.accessibilityElementsHidden).not.toBe(true);
    expect(node?.props.importantForAccessibility).not.toBe('no-hide-descendants');
  });
});
