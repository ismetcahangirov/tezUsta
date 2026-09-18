import { formatAddressDetail } from './format-address-detail';

const BLANK = {
  building: null,
  entrance: null,
  floor: null,
  apartment: null,
  landmarkNote: null,
};

describe('formatAddressDetail', () => {
  it('renders nothing when every field is null', () => {
    expect(formatAddressDetail(BLANK)).toBe('');
  });

  it('renders only the fields that are known', () => {
    expect(formatAddressDetail({ ...BLANK, building: '12B' })).toBe('bina 12B');
  });

  it('orders building, entrance, floor, apartment, then the landmark note', () => {
    expect(
      formatAddressDetail({
        building: '12B',
        entrance: '2',
        floor: '5',
        apartment: '48',
        landmarkNote: 'Marketin yanı',
      }),
    ).toBe('bina 12B, giriş 2, mərtəbə 5, mənzil 48, Marketin yanı');
  });

  it('accepts non-numeric entrances and floors, which is the whole point of these being strings', () => {
    expect(formatAddressDetail({ ...BLANK, entrance: 'B', floor: 'zirzəmi' })).toBe(
      'giriş B, mərtəbə zirzəmi',
    );
  });
});
