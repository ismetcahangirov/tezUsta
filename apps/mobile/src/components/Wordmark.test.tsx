import { render, screen } from '@testing-library/react-native';

import { Wordmark } from './Wordmark';

describe('Wordmark', () => {
  it('is announced as the brand name', async () => {
    await render(<Wordmark />);

    expect(screen.getByLabelText('TezUsta')).toBeOnTheScreen();
  });

  it('keeps the wordmark proportions at any width', async () => {
    await render(<Wordmark width={200} />);

    const svg = screen.getByLabelText('TezUsta');
    expect(svg.props.width).toBe(200);
    expect(Math.round(Number(svg.props.height))).toBe(41);
  });

  it.each([
    ['accent', 0xff1877f2],
    ['on-accent', 0xffffffff],
  ] as const)('draws every letter in "%s"', async (tone, argb) => {
    await render(<Wordmark tone={tone} />);

    expect(fills(screen.toJSON())).toEqual(Array.from({ length: 7 }, () => argb));
  });
});

interface Node {
  type: string;
  props: { fill?: { payload: number } };
  children: Node[] | null;
}

function fills(node: unknown): number[] {
  const n = node as Node;
  const own = n.type === 'RNSVGPath' && n.props.fill ? [n.props.fill.payload] : [];
  return [...own, ...(n.children ?? []).flatMap(fills)];
}
