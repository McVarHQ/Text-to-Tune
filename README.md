# Text-to-Tune
Instrumental Composition from Lyrics with LSTM-GAN

#Input Lyrics from Vocals - ![Sample/Billie-Vocals.wav]

Model Output Visualization - ![Sample/Screenshot.png]

MIDI Output, converted to wav for human ears - ![Sample/polysynth.wav]

Final Composition, output mixed with vocals - ![Sample/Billie-Mix.wav]


#requirements
python 2.7 and cuda 8.0.
gensim
pretty_midi
py_midi
tensorflow-gpu 1.14.0
jupyter
matplotlib
scikit-learn

## Folders
 - *Data*: a folder containing the raw file-by-file dataset to be preprocessed (songs_word_level) and a folder which stores the matrix-shaped dataset after pre-processing
 - *enc_models*: a folder containing the word2Vec and syllable2Vec model trained on our lyrics dataset
 - *saved_gan_models*: folder in which are stored the trained models for TexttoTune. 
 - *settings*: folder containing the settings files to be given as arguments for the training.

### Python files
- *lstm-gan-main*: Main model. To run (requires CUDA >= 8.0 and matching tensorflow-gpu version): python lstm-gan-lyrics2melody.py --settings_file settings
-*0.ipynb*: create the dataset matrices using the raw data present in ./data/songs_word_level.
-*3.ipynb*: generate triplets of music attributes for lyrics in the testing set.
-*4.ipynb*: generate a midi file for a given lyrics.
- Others: utilities function and MIDI processing tools
