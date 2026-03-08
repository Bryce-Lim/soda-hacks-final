# 👀 Sightline

<img width="426" height="299" alt="image" src="https://github.com/user-attachments/assets/0bfa2c7e-0583-410d-ab51-7a33d1a3537e" />

## 💡 Inspiration
Some people can't use their hands to control a mouse. There are various neurological and physical conditions that can cause significant motor control impairment, including full body paralysis. It is difficult or impossible for these people to use a mouse to navigate webpages, or even use voice control tools.

## 🧠 Solution
We created a chrome extension that allows you to navigate through any webpage with just your eyes. Once activated, it creates an embedded cursor which moves wherever your eyes look (using your camera to track your eyes). When you blink, you click on wherever you are looking.

## 🤖 WebEyeTrack ML
We use a SOTA ML model developed in a recent research paper (https://arxiv.org/abs/2508.19544) that uses a multilayer perceptron neural network to process eye movement and make gaze predictions. This performs better than traditional methods like WebGazer.

## ➡️ Running
1) Download the whole project
2) Go to chrome://extensions
3) Turn on developer mode
4) Click load unpacked, and select this whole folder

Then you can activate the extension whenever you want!
