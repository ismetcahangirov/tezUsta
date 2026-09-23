import { render, screen } from '@testing-library/react-native';

import { CONVERSATION_COPY as copy } from './conversation-copy';
import { TypingIndicator } from './TypingIndicator';

describe('TypingIndicator', () => {
  it('names who is typing', async () => {
    await render(<TypingIndicator label={copy.typing.master} />);

    expect(screen.getByText(copy.typing.master)).toBeOnTheScreen();
  });
});
