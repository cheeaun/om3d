for file in tiles/data/*.b3dm
do
  newFile="${file/tiles/optimized-tiles}"
  newFile="${newFile/b3dm/glb}"

  echo "🔄 Convert B3DM to GLB: ${file} -> ${newFile}"
  ./node_modules/.bin/3d-tiles-tools b3dmToGlb -i "$file" -o "$newFile"

  echo "🪠 Optimize GLB: ${newFile}"
  ./node_modules/.bin/gltf-pipeline -i "$newFile" -d --draco.quantizePositionBits 14 --draco.compressionLevel 10

  optimizedFile="${newFile/.glb/-processed.glb}"
  newOptimizedFile="${optimizedFile/-processed.glb/.b3dm}"

  echo "🔄 Convert GLB to B3DM: ${optimizedFile} -> ${newOptimizedFile}"
  ./node_modules/.bin/3d-tiles-tools glbToB3dm -i "$optimizedFile" -o "$newOptimizedFile"
done