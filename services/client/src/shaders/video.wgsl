struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vert_main(@builtin(vertex_index) i: u32) -> VertexOutput {
  var pos = array<vec2f, 4>(vec2f(-1, 1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, -1));
  var uv = array<vec2f, 4>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(1, 1));
  var out: VertexOutput;
  out.position = vec4f(pos[i], 0, 1);
  out.uv = uv[i];
  return out;
}

@group(0) @binding(0) var myTexture: texture_external;
@group(0) @binding(1) var mySampler: sampler; 

@fragment
fn frag_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // Use the 3-argument signature as required by your logs
  return textureSampleBaseClampToEdge(myTexture, mySampler, uv);
}