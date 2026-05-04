export type CheckClient = {
    id: string;
    type: "check";
}

export type OpenNoteCommand = {
    id: string;
    type: "note.open";
    path: string;
}

export type NoteReadCommand = {
    id: string;
    type: "note.read";
    path: string;
};

export type NoteCreateCommand = {
    id: string;
    type: "note.create";
    path: string;
    content: string[];
};

export type NoteReplaceCommand = {
    id: string;
    type: "note.replace";
    path: string;
    content: string[];
};

export type NoteFindByPropertyCommand = {
    id: string;
    type: "note.findByProperty";
    property: string;
    value: string | number | boolean;
};

export type NoteMoveCommand = {
    id: string;
    type: "note.move";
    path: string;
    newPath: string;
};

export type CommandRequest =
    | NoteReadCommand
    | NoteCreateCommand
    | NoteReplaceCommand
    | NoteFindByPropertyCommand
    | CheckClient
    | NoteMoveCommand
    | OpenNoteCommand;

export type CommandResponse =
    | {
        id: string;
        ok: true;
        result: unknown;
    }
    | {
        id: string;
        ok: false;
        error: string;
    };