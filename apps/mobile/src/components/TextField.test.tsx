import { fireEvent, render, screen } from '@testing-library/react-native';

import { TextField } from './TextField';

describe('TextField', () => {
  it('is reachable by its label', async () => {
    await render(<TextField label="Telefon nömrəsi" />);

    expect(screen.getByLabelText('Telefon nömrəsi')).toBeOnTheScreen();
  });

  it('reports what the user typed', async () => {
    const onChangeText = jest.fn();
    await render(<TextField label="Telefon nömrəsi" onChangeText={onChangeText} />);

    await fireEvent.changeText(screen.getByLabelText('Telefon nömrəsi'), '0501234567');

    expect(onChangeText).toHaveBeenCalledWith('0501234567');
  });

  it('shows the error and marks the field invalid', async () => {
    await render(<TextField label="Telefon nömrəsi" error="Nömrə düzgün deyil" />);

    expect(screen.getByText('Nömrə düzgün deyil')).toBeOnTheScreen();
    expect(screen.getByLabelText('Telefon nömrəsi')).toHaveProp('aria-invalid', true);
  });

  it('does not accept input when it is not editable', async () => {
    const onChangeText = jest.fn();
    await render(
      <TextField label="Telefon nömrəsi" onChangeText={onChangeText} editable={false} />,
    );

    expect(screen.getByLabelText('Telefon nömrəsi')).toBeDisabled();
  });

  it('takes several lines of writing when multi-line, starting at the top', async () => {
    const onChangeText = jest.fn();
    await render(<TextField label="Şərh" multiline onChangeText={onChangeText} />);

    const field = screen.getByLabelText('Şərh');
    await fireEvent.changeText(field, 'Vaxtında gəldi.\nSəliqəli işlədi.');

    expect(onChangeText).toHaveBeenCalledWith('Vaxtında gəldi.\nSəliqəli işlədi.');
    expect(field).toHaveProp('multiline', true);
    expect(field).toHaveProp('textAlignVertical', 'top');
  });
});
