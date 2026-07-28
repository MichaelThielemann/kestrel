// Bundled German word list for the passphrase suggestion (diceware-style). Short, common, unambiguous
// words; umlauts transliterated (ä→ae, ö→oe, ü→ue, ß→ss) so the password is trivial to type on any
// keyboard. All lowercase, no separators/spaces, no duplicates (guarded by a test). 296 words ≈ 8.2 bits
// each → the default 10-word passphrase carries ~82 bits — above the ~78-bit EFF-diceware norm, which is
// the bar that matters because the gallery ciphertext is permanently public and brute-forced offline.
// Consumers who want a bigger keyspace can pass a longer list or more words to `generatePassphrase`.
export const WORDLIST_DE: readonly string[] = [
  // sky & weather
  'sonne', 'mond', 'stern', 'himmel', 'wolke', 'regen', 'schnee', 'sturm', 'wind', 'blitz',
  'donner', 'nebel', 'frost', 'tau', 'eis', 'feuer', 'wasser', 'erde', 'luft', 'licht',
  'schatten', 'nacht', 'tag', 'morgen', 'abend', 'sommer', 'winter', 'fruehling', 'herbst', 'flamme',
  // plants
  'baum', 'busch', 'blume', 'rose', 'tulpe', 'nelke', 'lilie', 'gras', 'moos', 'farn',
  'pilz', 'blatt', 'ast', 'wurzel', 'samen', 'frucht', 'apfel', 'birne', 'kirsche', 'pflaume',
  'traube', 'beere', 'nuss', 'korn', 'weizen', 'hafer', 'klee', 'distel', 'efeu', 'tanne',
  'eiche', 'buche', 'birke', 'ahorn', 'weide', 'linde', 'kiefer', 'palme',
  // animals
  'esel', 'katze', 'hund', 'pferd', 'kuh', 'schwein', 'schaf', 'ziege', 'huhn', 'ente',
  'gans', 'hahn', 'maus', 'hase', 'fuchs', 'wolf', 'baer', 'hirsch', 'reh', 'igel',
  'biber', 'otter', 'robbe', 'wal', 'hai', 'fisch', 'krebs', 'biene', 'wespe', 'hummel',
  'kaefer', 'ameise', 'spinne', 'fliege', 'taube', 'eule', 'adler', 'rabe', 'spatz', 'storch',
  'schwan', 'moewe', 'kamel', 'loewe', 'tiger', 'zebra', 'affe', 'panda', 'dachs', 'luchs',
  // body & people
  'kopf', 'auge', 'ohr', 'nase', 'mund', 'zahn', 'hand', 'finger', 'arm', 'bein',
  'fuss', 'knie', 'herz', 'haut', 'haar', 'koenig', 'ritter', 'bauer', 'jaeger', 'fischer',
  'schmied', 'baecker', 'koch', 'kind', 'mann', 'frau', 'freund', 'nachbar', 'gast', 'held',
  // home & objects
  'tisch', 'stuhl', 'bett', 'lampe', 'tuer', 'fenster', 'dach', 'wand', 'treppe', 'keller',
  'garten', 'zaun', 'brunnen', 'muehle', 'bruecke', 'turm', 'burg', 'schloss', 'kirche', 'markt',
  'gasse', 'weg', 'strasse', 'platz', 'hafen', 'schiff', 'boot', 'wagen', 'rad', 'anker',
  'segel', 'ruder', 'netz', 'korb', 'eimer', 'kanne', 'krug', 'teller', 'loeffel', 'messer',
  'gabel', 'topf', 'pfanne', 'ofen', 'kerze', 'spiegel', 'uhr', 'schluessel', 'buch', 'feder',
  'tinte', 'brief', 'karte', 'muenze', 'ring', 'kette', 'krone', 'schwert', 'schild', 'bogen',
  'pfeil', 'hammer', 'nagel', 'saege', 'leiter', 'seil', 'faden', 'glocke',
  // actions
  'gehen', 'laufen', 'springen', 'fliegen', 'schwimmen', 'klettern', 'tanzen', 'singen', 'lachen', 'weinen',
  'schlafen', 'traeumen', 'denken', 'lesen', 'schreiben', 'malen', 'bauen', 'graben', 'saeen', 'ernten',
  'kochen', 'backen', 'jagen', 'fischen', 'reiten', 'segeln', 'rudern', 'wandern', 'sitzen', 'stehen',
  'liegen', 'fallen', 'steigen', 'finden', 'suchen', 'geben', 'nehmen', 'tragen', 'werfen', 'fangen',
  // qualities & colours
  'rot', 'blau', 'gruen', 'gelb', 'weiss', 'schwarz', 'grau', 'braun', 'bunt', 'hell',
  'dunkel', 'klein', 'gross', 'kurz', 'lang', 'schnell', 'langsam', 'leise', 'laut', 'warm',
  'kalt', 'weich', 'hart', 'rund', 'eckig', 'glatt', 'rauh', 'suess', 'sauer', 'frisch',
  'mild', 'wild', 'zahm', 'mutig', 'klug', 'stark', 'sanft', 'froh', 'ruhig', 'frei',
]
