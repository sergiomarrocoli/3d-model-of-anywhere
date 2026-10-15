// Bundle-local coordinates (x east, y north, z elevation; metres, origin = SW corner) -> three.js world (Y up).
//   world X =  x          (east)
//   world Y =  z - zRef   (up; zRef = lowest terrain height, keeps numbers small)
//   world Z = -y          (north is -Z, three's default "forward")
export const zRef = (meta) => meta.heightmap.min;
export const toWorld = (meta, x, y, z) => [x, z - zRef(meta), -y];
