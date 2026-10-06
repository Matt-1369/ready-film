// This draft becomes active only after its referenced outputs have been verified.
// Change the IDs, labels and filenames here if the generation targets change.
// Target labels are requests; measured polygon counts come from the loaded OBJ.
export const QUAD_VARIANTS = {
  knight: {
    defaultLevel: '8k',
    levels: [
      { id: '2k', label: '2,000 target', file: 'knight_q2k.obj', source: 'website-addition' },
      { id: '8k', label: '8,000 target', file: 'knight_q8k.obj', source: 'website-addition' },
      { id: '15k', label: '15,000 target', file: 'knight_q15k.obj', source: 'website-addition' },
    ],
  },
  tavern: {
    defaultLevel: '5k',
    levels: [
      { id: '2k', label: '2,000 target', file: 'tavern_q2k.obj', source: 'film' },
      { id: '5k', label: '5,000 target', file: 'tavern_q5k.obj', source: 'film' },
      { id: '10k', label: '10,000 target', file: 'tavern_q10k.obj', source: 'film' },
      { id: '15k', label: '15,000 target', file: 'tavern_q15k.obj', source: 'film' },
    ],
  },
};

export const PART_MODELS = {
  knight: { file: 'knight_seg.glb', source: 'film' },
  tavern: { file: 'tavern_seg.glb', source: 'website-addition' },
};
