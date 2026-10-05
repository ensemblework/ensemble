const desks = ["default", "semester", "exam", "literature", "chambers", "classes", "staff", "branch", "bench"];
export default [
  { name: "A1-widget-kit-1440", q: "p=kit", full: true },
  { name: "A2-three-states-1440", q: "p=states", full: true },
  ...desks.map((d) => ({ name: `B-today-${d}-1440`, q: `p=today&d=${d}`, full: true })),
  ...["chambers", "exam", "branch"].map((d) => ({ name: `B-today-${d}-390`, q: `p=today&d=${d}&m=1`, w: 390, full: true })),
  { name: "C-newuser-chambers-1440", q: "p=new&d=chambers", full: true },
  { name: "C-newuser-semester-1440", q: "p=new&d=semester", full: true },
  { name: "D-context-chambers-1440", q: "p=context&d=chambers", full: true },
  { name: "D-context-literature-1440", q: "p=context&d=literature", full: true },
  { name: "E-gallery-1440", q: "p=gallery", full: true },
  { name: "E-gallery-390", q: "p=gallery&m=1", w: 390, full: true },
  { name: "F-detail-chambers-1440", q: "p=detail", full: true },
  { name: "G-apply-1-rearranging-1440", q: "p=apply&phase=1" },
  { name: "G-apply-2-toast-1440", q: "p=apply&phase=2" },
  { name: "H-before-after-1440", q: "p=compare", full: true, fold: false },
  { name: "X-plots-widget-gallery-1440", q: "p=plots-gallery" },
  { name: "X-plots-tile-settings-1440", q: "p=plots-settings" },
];
