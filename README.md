# Brosé

A landing page for Brosé the brand with an 3D metallic logo made in blender.

## Features

- A metallic 3D logo that spins slowly like a coin
- A soft shadow that narrows and widens with the rotation

## How it works

1. I modelled the logo in **Blender**, starting from an SVG, which I converted to a mesh and gave a metallic material.
2. I made the fold animation in Blender with **shape keys** and keyframes.
3. I exported the logo as a **.glb file** (glTF binary), the standard format for 3D on the web.
4. The website shows the logo with **model-viewer**, a web component by Google that handles rotation and plays the Blender animation.
5. The shadow is made with **CSS**, because model-viewer's built-in shadow didn't work well for an upright logo.

## Technical choices

I compared model-viewer, three.js and Spline. I chose model-viewer because it gave me the features I needed with a learning curve that fit my skills and the time I had. three.js offers more control but would take too long to learn in this project, and Spline makes the site depend on an external platform.

## Tools

- Blender (3D modelling and animation)
- HTML, CSS
- model-viewer
- VS Code with Live Server
- Git and GitHub
- [Claude (AI) helped me write parts of the code, which I then adjusted and tested myself.]

## Run it locally

Open the folder in VS Code and use the **Live Server** extension. Opening index.html directly doesn't work, because browsers block loading 3D files from a local file.

## What I would improve next

- Compress the 3D model so the page loads faster
- Make the logo more interactive
