import { fireEvent, render, screen } from '@testing-library/react-native';

import { Composer, MAX_MESSAGE_LENGTH } from './Composer';
import { CONVERSATION_COPY as copy } from './conversation-copy';

describe('Composer', () => {
  it('sends what was typed and clears the field', async () => {
    const onSend = jest.fn();
    await render(<Composer onSend={onSend} />);

    await fireEvent.changeText(screen.getByLabelText(copy.composerLabel), 'Gəlirəm');
    await fireEvent.press(screen.getByRole('button', { name: copy.send }));

    expect(onSend).toHaveBeenCalledWith('Gəlirəm');
    expect(screen.getByLabelText(copy.composerLabel)).toHaveDisplayValue('');
  });

  it('cannot send an empty or blank message', async () => {
    const onSend = jest.fn();
    await render(<Composer onSend={onSend} />);

    expect(screen.getByRole('button', { name: copy.send })).toBeDisabled();

    await fireEvent.changeText(screen.getByLabelText(copy.composerLabel), '   ');
    expect(screen.getByRole('button', { name: copy.send })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: copy.send }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('reports typing on every change', async () => {
    const onTyping = jest.fn();
    await render(<Composer onSend={jest.fn()} onTyping={onTyping} />);

    await fireEvent.changeText(screen.getByLabelText(copy.composerLabel), 'S');
    await fireEvent.changeText(screen.getByLabelText(copy.composerLabel), 'Sa');

    expect(onTyping).toHaveBeenCalledTimes(2);
  });

  it('holds the field to the server’s length limit', async () => {
    await render(<Composer onSend={jest.fn()} />);

    expect(screen.getByLabelText(copy.composerLabel)).toHaveProp('maxLength', MAX_MESSAGE_LENGTH);
  });
});
