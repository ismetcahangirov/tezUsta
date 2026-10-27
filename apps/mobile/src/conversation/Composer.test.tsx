import { fireEvent, render, screen } from '@testing-library/react-native';

import { Composer, MAX_MESSAGE_LENGTH } from './Composer';
import { CONVERSATION_COPY as copy } from './conversation-copy';
import type { DraftPhoto, MessagePhotos } from './useMessagePhotos';

function photos(drafted: readonly DraftPhoto[], overrides: Partial<MessagePhotos> = {}) {
  return {
    photos: drafted,
    isPicking: false,
    permissionDenied: false,
    canAdd: true,
    ready: drafted.every((photo) => photo.status === 'ready'),
    pick: jest.fn(() => Promise.resolve()),
    remove: jest.fn(),
    take: jest.fn(() => []),
    ...overrides,
  } satisfies MessagePhotos;
}

const READY: DraftPhoto = { localId: 'p-1', uri: 'file:///cache/p-1.jpg', status: 'ready' };

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

  describe('photos (#456)', () => {
    it('offers no photo control to a text-only composer', async () => {
      await render(<Composer onSend={jest.fn()} />);

      expect(screen.queryByRole('button', { name: copy.attachPhoto })).toBeNull();
    });

    it('opens the library from the photo control, until the message is full', async () => {
      const drafts = photos([]);
      const { rerender } = await render(<Composer onSend={jest.fn()} photos={drafts} />);

      await fireEvent.press(screen.getByRole('button', { name: copy.attachPhoto }));
      expect(drafts.pick).toHaveBeenCalledTimes(1);

      await rerender(<Composer onSend={jest.fn()} photos={photos([READY], { canAdd: false })} />);
      expect(screen.getByRole('button', { name: copy.attachPhoto })).toBeDisabled();
    });

    it('sends a photo with no text', async () => {
      const onSend = jest.fn();
      await render(<Composer onSend={onSend} photos={photos([READY])} />);

      await fireEvent.press(screen.getByRole('button', { name: copy.send }));

      expect(onSend).toHaveBeenCalledWith('');
    });

    it('waits for every photo to upload, and says which one is on its way', async () => {
      const uploading: DraftPhoto = { ...READY, localId: 'p-2', status: 'uploading' };
      await render(<Composer onSend={jest.fn()} photos={photos([READY, uploading])} />);

      await fireEvent.changeText(screen.getByLabelText(copy.composerLabel), 'Bax');

      expect(screen.getByText(copy.photoUploading)).toBeOnTheScreen();
      expect(screen.getByRole('button', { name: copy.send })).toBeDisabled();
    });

    it('says a photo failed and lets it be removed', async () => {
      const drafts = photos([{ ...READY, status: 'failed' }]);
      await render(<Composer onSend={jest.fn()} photos={drafts} />);

      expect(screen.getByText(copy.photoUploadFailed)).toBeOnTheScreen();
      expect(screen.getByRole('button', { name: copy.send })).toBeDisabled();

      await fireEvent.press(screen.getByRole('button', { name: copy.removePhoto }));
      expect(drafts.remove).toHaveBeenCalledWith('p-1');
    });

    it('says why nothing can be picked when the library was refused', async () => {
      await render(<Composer onSend={jest.fn()} photos={photos([], { permissionDenied: true })} />);

      expect(screen.getByText(copy.photoPermissionDenied)).toBeOnTheScreen();
    });
  });
});
