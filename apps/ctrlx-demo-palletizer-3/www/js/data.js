// Standard pallet sizes (mm). L = length along X, W = width along Y.
export const STANDARD_PALLETS = [
  { id: 'eur1', name: 'EUR / EPAL 1', L: 1200, W: 800, H: 144, weight: 25, maxH: 1800, maxKg: 1500, std: true },
  { id: 'eur2', name: 'EUR 2 / ISO 1200×1000', L: 1200, W: 1000, H: 144, weight: 33, maxH: 1800, maxKg: 1250, std: true },
  { id: 'eur3', name: 'EUR 3', L: 1000, W: 1200, H: 144, weight: 29, maxH: 1800, maxKg: 1500, std: true },
  { id: 'eur6', name: 'EUR 6 (half)', L: 800, W: 600, H: 144, weight: 9.5, maxH: 1800, maxKg: 500, std: true },
  { id: 'qtr', name: 'Quarter pallet', L: 600, W: 400, H: 144, weight: 5, maxH: 1000, maxKg: 250, std: true },
  { id: 'gma', name: 'GMA 48×40 in (NA)', L: 1219, W: 1016, H: 140, weight: 22, maxH: 1800, maxKg: 1250, std: true },
  { id: 'us4242', name: '42×42 in', L: 1067, W: 1067, H: 140, weight: 22, maxH: 1800, maxKg: 1250, std: true },
  { id: 'us4848', name: '48×48 in', L: 1219, W: 1219, H: 140, weight: 25, maxH: 1800, maxKg: 1250, std: true },
  { id: 'asia', name: 'Asia 1100×1100', L: 1100, W: 1100, H: 150, weight: 20, maxH: 1800, maxKg: 1000, std: true },
  { id: 'aus', name: 'Australian 1165×1165', L: 1165, W: 1165, H: 150, weight: 25, maxH: 1800, maxKg: 1000, std: true },
  { id: 'iso1067', name: 'ISO 1067×1067', L: 1067, W: 1067, H: 150, weight: 22, maxH: 1800, maxKg: 1000, std: true },
];

export const BOX_COLORS = ['#c8a26b', '#5aa9e6', '#7fc8a9', '#e6a15a', '#b48ee0', '#e07a8e', '#d9d36a', '#6ad0d9'];

export function defaultProject() {
  return {
    format: 'ctrlx-palletizer/1',
    name: 'pattern_01',
    palletId: 'eur1',
    customPallets: [],
    boxTypes: [
      { id: 'bx1', name: 'Carton 400×300', L: 400, W: 300, H: 250, weight: 8, color: '#c8a26b', labelSide: 'front', image: null, imageMode: 'top' },
      { id: 'bx2', name: 'Carton 600×400', L: 600, W: 400, H: 300, weight: 14, color: '#5aa9e6', labelSide: 'front', image: null, imageMode: 'top' },
      { id: 'bx3', name: 'Tray 300×200', L: 300, W: 200, H: 120, weight: 3.5, color: '#7fc8a9', labelSide: 'right', image: null, imageMode: 'top' },
    ],
    settings: {
      margins: { left: 0, right: 0, front: 0, back: 0 },
      marginLink: true,
      spacing: 0,
      slip: 0,
      grid: 5,
      snapPx: 10,
      csv: { delim: ',', decimals: 1, origin: 'corner', zZero: 'palletTop', zRef: 'top', rotRange: '360', order: 'placed', header: true, dims: true },
    },
    layers: [{ id: 'L1', boxes: [] }],
  };
}
