/**
 * Verbatim Make module 46 response schema (Gemini responseSchema dialect:
 * `nullable`, `propertyOrdering`). A test asserts deep equality with
 * docs/make-reference/classification-schema.make.json.
 */
export const RESPONSE_SCHEMA = {
  "type": "object",
  "properties": {
    "person_path": {
      "type": "string",
      "nullable": true,
      "description": "Dossier matériel concerné; BERCLAZ_Valentin uniquement pour courrier personnel de Valentin, jamais du seul fait qu'il est curateur ou destinataire.",
      "enum": [
        "GUEX Antonietta",
        "DUPLAIN Nicole",
        "ÖZTÜRK Haci Ali",
        "PERROTTA Alexandre",
        "POUSAZ Jean-Marie et Zohra",
        "SCHAFEITEL Christophe",
        "SHARMA FERRARI Pooja",
        "TOGNI Marianna",
        "WEBER Chantal Magali",
        "WEISS Jacques",
        "BERCLAZ_Valentin"
      ]
    },
    "person_full_name": {
      "type": "string",
      "nullable": true,
      "description": "Nom du sujet matériel du document, y compris Valentin pour courrier personnel; null sinon."
    },
    "document_date_iso": {
      "type": "string",
      "format": "date",
      "description": "Date d'émission YYYY-MM-DD; null si absente ou incertaine. Jamais inventer la date du jour.",
      "nullable": true
    },
    "document_type": {
      "type": "string",
      "description": "Type le plus précis; FACTURE uniquement s'il s'agit d'une facture à payer.",
      "enum": [
        "FACTURE",
        "DECOMPTE",
        "RAPPEL",
        "COURRIER",
        "RAPPORT_MEDICAL",
        "DECISION_ADMIN",
        "DECISION_APEA",
        "ACTE_NOMINATION",
        "CONVOCATION",
        "FORMULAIRE",
        "ATTESTATION",
        "RELEVE_BANCAIRE",
        "IMPOTS",
        "POURSUITES",
        "DIVERS"
      ]
    },
    "issuer": {
      "type": "string",
      "nullable": true,
      "description": "Nom complet de l’expéditeur principal, ou null si non identifiable."
    },
    "short_issuer": {
      "type": "string",
      "description": "Code A-Z/0-9/underscore <=10 caractères; INCONNU si nécessaire."
    },
    "file_label": {
      "type": "string",
      "description": "Résumé objet court en français, sans date d'émission, expéditeur déjà codé ni nom de personne; max 60 caractères."
    },
    "needs_review": {
      "type": "boolean",
      "description": "True si classement, date, type, lecture ou auteur incertain, ou plusieurs documents."
    },
    "review_reason": {
      "type": "string",
      "nullable": true,
      "description": "Motif concis si needs_review, null sinon."
    },
    "action_required": {
      "type": "boolean",
      "description": "Indique si le document nécessite une action."
    },
    "deadline_iso": {
      "type": "string",
      "format": "date",
      "nullable": true,
      "description": "Échéance au format YYYY-MM-DD, ou null en l’absence d’échéance."
    },
    "amount_chf": {
      "type": "number",
      "minimum": 0,
      "nullable": true,
      "description": "Montant principal en francs suisses, ou null si non applicable."
    },
    "document_reference": {
      "type": "string",
      "nullable": true,
      "description": "Référence, numéro de facture, numéro de décision ou autre identifiant du document."
    }
  },
  "required": [
    "person_path",
    "person_full_name",
    "document_date_iso",
    "document_type",
    "issuer",
    "short_issuer",
    "file_label",
    "needs_review",
    "review_reason",
    "action_required",
    "deadline_iso",
    "amount_chf",
    "document_reference"
  ],
  "propertyOrdering": [
    "person_path",
    "person_full_name",
    "document_date_iso",
    "document_type",
    "issuer",
    "short_issuer",
    "file_label",
    "needs_review",
    "review_reason",
    "action_required",
    "deadline_iso",
    "amount_chf",
    "document_reference"
  ]
};

export const PERSON_PATHS: readonly string[] = RESPONSE_SCHEMA.properties.person_path.enum;
export const DOCUMENT_TYPES: readonly string[] = RESPONSE_SCHEMA.properties.document_type.enum;
