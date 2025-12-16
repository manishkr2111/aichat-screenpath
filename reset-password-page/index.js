module.exports = async function (context, req) {
    context.res = {
        status: 200,
        headers: { "Content-Type": "text/html" },
        body: `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>Reset Password</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    background: #f4f6f8;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    margin: 0;
                }
                .container {
                    background: #fff;
                    padding: 40px 30px;
                    border-radius: 10px;
                    box-shadow: 0 4px 15px rgba(0,0,0,0.1);
                    width: 100%;
                    max-width: 400px;
                    text-align: center;
                }
                h3 {
                    margin-bottom: 30px;
                    color: #333;
                }
                input[type="password"] {
                    width: 100%;
                    padding: 12px 15px;
                    margin: 10px 0;
                    border-radius: 6px;
                    border: 1px solid #ccc;
                    font-size: 16px;
                }
                button {
                    width: 100%;
                    padding: 12px;
                    margin-top: 15px;
                    border: none;
                    border-radius: 6px;
                    background-color: #007bff;
                    color: white;
                    font-size: 16px;
                    cursor: pointer;
                    transition: background 0.3s ease;
                }
                button:hover {
                    background-color: #0056b3;
                }
                #message {
                    margin-top: 15px;
                    font-size: 14px;
                    color: red;
                    min-height: 20px;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h3>Reset Your Password</h3>
                <form id="resetForm">
                    <input type="password" id="newPassword" placeholder="New Password" required />
                    <input type="password" id="confirmPassword" placeholder="Confirm Password" required />
                    <button type="submit">Reset Password</button>
                </form>
                <div id="message"></div>
            </div>

            <script>
                const urlParams = new URLSearchParams(window.location.search);
                const token = urlParams.get('token');

                document.getElementById('resetForm').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const newPassword = document.getElementById('newPassword').value;
                    const confirmPassword = document.getElementById('confirmPassword').value;
                    const messageDiv = document.getElementById('message');

                    if(newPassword !== confirmPassword){
                        messageDiv.textContent = "Passwords do not match";
                        return;
                    }

                    const res = await fetch('/api/reset-password', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ token, newPassword })
                    });

                    const data = await res.json();
                    messageDiv.textContent = data.message;

                    if(res.status === 200){
                        messageDiv.style.color = "green";
                        // setTimeout(() => {
                        //     window.location.href = "/login"; // redirect after successful reset
                        // }, 2000);
                    } else {
                        messageDiv.style.color = "red";
                    }
                });
            </script>
        </body>
        </html>
        `
    };
};
