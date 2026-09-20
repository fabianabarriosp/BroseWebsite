const canvas = document.getElementById("fluidCanvas");
const ctx = canvas.getContext("2d");

let width;
let height;

function resize() {
  width = canvas.width = window.innerWidth;
  height = canvas.height = window.innerHeight;
}

window.addEventListener("resize", resize);
resize();

const particles = [];

const PARTICLE_COUNT = 1500;

for (let i = 0; i < PARTICLE_COUNT; i++) {
  particles.push({
    x: Math.random() * width,
    y: Math.random() * height,
    vx: 0,
    vy: 0,
    size: Math.random() * 2 + 0.5,
  });
}

function animate() {
  ctx.fillStyle = "rgba(179, 21, 13, 0.08)";
  ctx.fillRect(0, 0, width, height);

  for (const p of particles) {
    // Fluid-like velocity field
    const angle = Math.sin(p.y * 0.008 + performance.now() * 0.001) * Math.PI;

    p.vx += Math.cos(angle) * 0.08;
    p.vy += Math.sin(angle) * 0.08;

    // Mouse interaction
    const dx = mouse.x - p.x;
    const dy = mouse.y - p.y;

    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < 180) {
      p.vx -= (dx / distance) * 0.5;
      p.vy -= (dy / distance) * 0.5;
    }

    // Friction
    p.vx *= 0.97;
    p.vy *= 0.97;

    p.x += p.vx;
    p.y += p.vy;

    // Wrap around screen
    if (p.x < 0) p.x = width;
    if (p.x > width) p.x = 0;

    if (p.y < 0) p.y = height;
    if (p.y > height) p.y = 0;

    ctx.beginPath();

    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);

    ctx.fillStyle = "rgba(255, 190, 190, 0.7)";
    ctx.fill();
  }

  requestAnimationFrame(animate);
}

const mouse = {
  x: width / 2,
  y: height / 2,
};

window.addEventListener("mousemove", (event) => {
  mouse.x = event.clientX;
  mouse.y = event.clientY;
});

animate();
