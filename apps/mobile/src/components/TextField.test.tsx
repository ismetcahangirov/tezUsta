import { fireEvent, render, screen } from '@testing-library/react-native';

import { TextField } from './TextField';

describe('TextField', () => {
  it('is reachable by its label', async () => {
    await render(<TextField label="E-poçt ünvanı" />);

    expect(screen.getByLabelText('E-poçt ünvanı')).toBeOnTheScreen();
  });

  it('reports what the user typed', async () => {
    const onChangeText = jest.fn();
    await render(<TextField label="E-poçt ünvanı" onChangeText={onChangeText} />);

    await fireEvent.changeText(screen.getByLabelText('E-poçt ünvanı'), 'aysel@example.az');

    expect(onChangeText).toHaveBeenCalledWith('aysel@example.az');
  });

  it('shows the error and marks the field invalid', async () => {
    await render(<TextField label="E-poçt ünvanı" error="E-poçt ünvanı düzgün deyil" />);

    expect(screen.getByText('E-poçt ünvanı düzgün deyil')).toBeOnTheScreen();
    expect(screen.getByLabelText('E-poçt ünvanı')).toHaveProp('aria-invalid', true);
  });

  it('does not accept input when it is not editable', async () => {
    const onChangeText = jest.fn();
    await render(<TextField label="E-poçt ünvanı" onChangeText={onChangeText} editable={false} />);

    expect(screen.getByLabelText('E-poçt ünvanı')).toBeDisabled();
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
