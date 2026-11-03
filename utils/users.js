const users = new Map();

function userJoin(id,username, room, role = 'student'){
    const user = {id,username,room,role};
    users.set(id, user);
    return user;
}

function getRoom(room){
    return [...users.values()].filter(user=>user.room === room);
}

function getCurrentUser(id){
    return users.get(id);
}

function userLeave(id){
    const user = users.get(id);
    users.delete(id);
    return user;
}
module.exports = {
    userJoin,
    getCurrentUser,
    userLeave,
    getRoom
};
